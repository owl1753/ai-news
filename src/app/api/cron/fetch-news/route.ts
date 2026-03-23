import { XMLParser } from "fast-xml-parser";
import { cookies, headers } from "next/headers";
import * as z from "zod";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import {
  generateText,
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

const prompt = `
당신은 뉴스 대본 작성자입니다. title, description, content로 구성된 데이터 리스트를 입력받아서, 한국어로 된 뉴스 대본을 출력하면 됩니다.

분량은 각 소식 별로 2분 내외 정도로 설정합니다.

만약 내용이 겹치는 소식이 있다면, 하나로 합쳐서 소개합니다.

대본은 tts를 통해 음성 데이터로 바로 변환되기 때문에 오로지 텍스트만 포함해야 합니다.
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

export async function textToSpeech(text: string, headlines: string[]) {
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
  "https://techcrunch.com/category/artificial-intelligence/feed/",
  "https://www.artificialintelligence-news.com/feed/",
  "https://venturebeat.com/category/ai/feed/",
  "https://magazine.sebastianraschka.com/feed",
  "https://ai-techpark.com/category/ai/feed/",
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
    const items = (
      await Promise.all(
        sources.map(async (source) => {
          const data = await fetch(source);

          console.log(`RSS 피드 가져오기 성공: ${source}`);

          const xml = await data.text();

          return itemsSchema
            .parse(parser.parse(xml).rss.channel.item)
            .filter(
              (item) =>
                Date.now() - item.pubDate.getTime() < 24 * 60 * 60 * 1000,
            );
        }),
      )
    ).flat();

    const itemsWithContent = await Promise.all(
      items.map(async (item) => {
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
    });

    console.log("대본 생성 완료");

    await textToSpeech(
      text,
      itemsWithContent.map((item) => item.title),
    );

    console.log("생성 완료");

    return Response.json({ success: true });
  } catch (e) {
    console.log(e);
    return Response.json({ error: "Invalid XML" }, { status: 400 });
  }
}
