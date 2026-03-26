import { XMLParser } from "fast-xml-parser";
import { cookies, headers } from "next/headers";
import * as z from "zod";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import {
  generateText,
  Output,
  experimental_generateSpeech as generateSpeech,
} from "ai";
import { openai } from "@ai-sdk/openai";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { createClient } from "@/app/utils/supabase/server";

const itemSchema = z.object({
  description: z.string(),
  link: z.url(),
  pubDate: z.string().transform((date) => new Date(date)),
  title: z.string(),
});

const itemsSchema = z.array(itemSchema);

const filterPrompt = `
당신은 AI 뉴스 필터링 전문가입니다. 뉴스 목록을 입력받아 다음 두 가지 기준으로 필터링합니다:

1. AI 관련성: 인공지능(AI), 머신러닝, 딥러닝, LLM, 생성형 AI 등과 직접적으로 관련된 뉴스만 남깁니다. AI와 무관한 일반 기술 뉴스는 제외합니다.
2. 중복 제거: 같은 사건/주제를 다루는 뉴스가 여러 개 있으면, 가장 먼저 등장한 것만 남기고 나머지는 제외합니다.

각 뉴스의 index(0부터 시작)를 입력받은 순서대로 평가하고, 통과한 뉴스의 index만 반환하세요.
`;

const prompt = `
당신은 AI 뉴스 전문 대본 작성자입니다. 인공지능(AI) 관련 뉴스만을 다루는 전문 뉴스 프로그램의 대본을 작성합니다.

title, description, content로 구성된 AI 뉴스 데이터 리스트를 입력받아서, 한국어로 된 AI 뉴스 대본을 출력하면 됩니다.

중요: 입력된 모든 AI 뉴스를 빠짐없이 다뤄야 합니다. 어떤 뉴스도 생략하지 마세요.

분량은 각 소식 별로 1~2분 정도로 설정합니다.

만약 소식이 중복된다면 있다면, 뒤에 들어온 중복된 소식을 무시합니다.

대본은 tts를 통해 음성 데이터로 바로 변환되기 때문에 오로지 텍스트만 포함해야 합니다.
[오프닝], [클로징], [뉴스 1] 같은 대괄호 마커, 제목 표시, 구분 기호 등을 절대 넣지 마세요. 모든 내용이 자연스럽게 읽히는 문장으로만 구성되어야 합니다.
`;

function splitText(text: string, maxLength = 4000): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split(/\n+/)) {
    if ((current + "\n" + paragraph).length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = paragraph;
    } else {
      current += "\n" + paragraph;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function textToSpeech(
  text: string,
  headlines: { title: string; link: string }[],
) {
  const chunks = splitText(text);

  const tmpDir = path.join(process.cwd(), "tmp", randomUUID());
  const outputPath = path.join(
    process.cwd(),
    `${new Date().toISOString().split("T")[0]}.mp3`,
  );
  await fs.mkdir(tmpDir, { recursive: true });

  // 청크별 TTS 호출
  const chunkPaths: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const { audio } = await generateSpeech({
      model: openai.speech("tts-1"),
      text: chunks[i],
      voice: "alloy",
    });

    const chunkPath = path.join(tmpDir, `chunk_${i}.mp3`);
    await fs.writeFile(chunkPath, Buffer.from(audio.uint8Array));
    chunkPaths.push(chunkPath);
  }

  // ffmpeg concat demuxer
  const listPath = path.join(tmpDir, "list.txt");
  const listContent = chunkPaths.map((p) => `file '${p}'`).join("\n");
  await fs.writeFile(listPath, listContent);

  const proc = Bun.spawn([
    "ffmpeg",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    outputPath,
  ]);
  await proc.exited;

  // 임시 파일 삭제
  await fs.rm(tmpDir, { recursive: true });

  const supabase = await createClient(await cookies());
  const fileName = `${new Date().toISOString().split("T")[0]}.mp3`;
  const fileBuffer = await fs.readFile(outputPath);

  const { error: uploadError } = await supabase.storage
    .from("audio-news")
    .upload(fileName, fileBuffer, { contentType: "audio/mpeg" });

  if (uploadError) throw uploadError;

  const {
    data: { publicUrl },
  } = supabase.storage.from("audio-news").getPublicUrl(fileName);

  await fs.unlink(outputPath);

  const { error: dbError } = await supabase.from("audio_news").insert({
    audio_url: publicUrl,
    script: text,
    headlines,
  });

  if (dbError) throw dbError;
}

const sources = [
  "https://techcrunch.com/category/artificial-intelligence/feed/", // TechCrunch
  "https://www.artificialintelligence-news.com/feed/", // AI News
  "https://venturebeat.com/category/ai/feed/", // VentureBeat
  "https://aimodels.substack.com/feed", // AIModels.fyi
  "https://magazine.sebastianraschka.com/feed", // Ahead of AI
  "https://ai-techpark.com/category/ai/feed/", // AI-TechPark
  "https://www.404media.co/rss/", // 404 Media
  "https://www.techrepublic.com/rssfeeds/topic/artificial-intelligence/", // Artificial Intelligence News -- ScienceDaily
  "https://gradientflow.com/feed/", // Gradient Flow
];

export async function GET() {
  const headersList = await headers();
  const authHeader = headersList.get("authorization");

  if (authHeader != `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log("인증 성공");

  const parser = new XMLParser();
  try {
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          const data = await fetch(source);
          const xml = await data.text();
          const parsed = itemsSchema
            .parse(parser.parse(xml).rss.channel.item)
            .filter(
              (item) =>
                Date.now() - item.pubDate.getTime() < 24 * 60 * 60 * 1000,
            );
          console.log(`RSS 피드 가져오기 성공: ${source}`);
          return parsed;
        } catch (e) {
          console.error(`RSS 피드 가져오기 실패 (스킵): ${source}`, e);
          return [];
        }
      }),
    );
    const items = results.flat();

    // AI 뉴스 필터링 및 중복 제거 (content fetch 전에 수행)
    const filterInput = items.map((item, index) => ({
      index,
      title: item.title,
      description: item.description,
    }));

    const { output: filterResult } = await generateText({
      model: openai("gpt-5.4-mini"),
      output: Output.object({
        schema: z.object({
          selectedIndices: z
            .array(z.number())
            .describe("통과한 뉴스의 index 배열"),
        }),
      }),
      system: filterPrompt,
      prompt: JSON.stringify(filterInput),
      providerOptions: {
        openai: {
          reasoningEffort: "low",
        },
      },
    });

    const selectedIndices = new Set(filterResult?.selectedIndices ?? []);
    const filteredItems = items.filter((_, i) => selectedIndices.has(i));

    console.log(
      `필터링 완료: ${items.length}개 중 ${filteredItems.length}개 선택`,
    );

    if (filteredItems.length === 0) {
      return Response.json({ success: true, message: "AI 뉴스 없음" });
    }

    const itemsWithContent = await Promise.all(
      filteredItems.map(async (item) => {
        const data = await fetch(item.link);
        const html = await data.text();
        const { document } = parseHTML(html);
        const reader = new Readability(document);
        const article = reader.parse();
        return {
          ...item,
          content: article?.textContent ?? "",
        };
      }),
    );

    console.log("포스트 content 가져오기 성공");

    const { text } = await generateText({
      model: openai("gpt-5.4-mini"),
      system: prompt,
      prompt: JSON.stringify(itemsWithContent),
      providerOptions: {
        openai: {
          reasoningEffort: "low",
        },
      },
    });

    console.log("대본 생성 완료");

    await textToSpeech(
      text,
      filteredItems.map((item) => ({ title: item.title, link: item.link })),
    );

    console.log("생성 완료");

    return Response.json({ success: true });
  } catch (e) {
    console.error(e);

    if (e instanceof z.ZodError) {
      return Response.json(
        { error: "RSS 파싱 실패", details: e.issues },
        { status: 400 },
      );
    }

    if (e instanceof Error) {
      if (e.message.includes("fetch")) {
        return Response.json(
          { error: "RSS 피드 가져오기 실패", message: e.message },
          { status: 502 },
        );
      }

      if (e.message.includes("storage") || e.message.includes("upload")) {
        return Response.json(
          { error: "파일 업로드 실패", message: e.message },
          { status: 500 },
        );
      }

      return Response.json(
        { error: "서버 오류", message: e.message },
        { status: 500 },
      );
    }

    return Response.json({ error: "알 수 없는 오류" }, { status: 500 });
  }
}
