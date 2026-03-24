// app/components/news-card-list.tsx
import { createClient } from "@/app/utils/supabase/server";
import { cookies } from "next/headers";

export async function NewsCardList() {
  const supabase = await createClient(await cookies());
  const { data: news } = await supabase
    .from("audio_news")
    .select("*")
    .order("created_at", { ascending: false });

  if (!news?.length) return <p>생성된 뉴스가 없습니다.</p>;

  return (
    <div className="flex flex-col gap-4 p-4">
      {news.map((item) => (
        <div
          key={item.id}
          className="border rounded-lg p-4 flex flex-col gap-3"
        >
          <p className="text-sm text-gray-500">
            {new Date(item.created_at).toLocaleDateString("ko-KR")}
          </p>
          <ul className="flex flex-col gap-1">
            {item.headlines.map(
              (headline: string | { title: string; link: string }, i: number) => (
                <li key={i} className="text-sm">
                  •{" "}
                  {typeof headline === "string" ? (
                    headline
                  ) : (
                    <a
                      href={headline.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline text-blue-600"
                    >
                      {headline.title}
                    </a>
                  )}
                </li>
              ),
            )}
          </ul>
          <audio controls src={`${item.audio_url}?v=${new Date(item.created_at).getTime()}`} className="w-full" />
        </div>
      ))}
    </div>
  );
}
