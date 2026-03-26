import { createClient } from "@/app/utils/supabase/server";
import { cookies } from "next/headers";
import { DeleteButton } from "./delete-button";
import { LoginForm } from "./login-form";
import { isAuthenticated } from "./actions";

export default async function AdminPage() {
  const authed = await isAuthenticated();

  if (!authed) {
    return (
      <main className="max-w-3xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-6">관리자 로그인</h1>
        <LoginForm />
      </main>
    );
  }

  const supabase = await createClient(await cookies());
  const { data: news } = await supabase
    .from("audio_news")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">관리자 페이지</h1>

      {!news?.length ? (
        <p className="text-gray-500">뉴스가 없습니다.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {news.map((item) => (
            <div
              key={item.id}
              className="border rounded-lg p-4 flex flex-col gap-3"
            >
              <div className="flex justify-between items-start">
                <p className="text-sm text-gray-500">
                  {new Date(item.created_at).toLocaleDateString("ko-KR")}
                </p>
                <DeleteButton id={item.id} />
              </div>
              <ul className="flex flex-col gap-1">
                {item.headlines.map(
                  (
                    headline: string | { title: string; link: string },
                    i: number,
                  ) => (
                    <li key={i} className="text-sm">
                      •{" "}
                      {typeof headline === "string"
                        ? headline
                        : headline.title}
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
