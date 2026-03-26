"use server";

import { createClient } from "@/app/utils/supabase/server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

export async function login(password: string) {
  if (password !== process.env.ADMIN_PASSWORD) {
    return { error: "비밀번호가 틀렸습니다." };
  }

  const cookieStore = await cookies();
  cookieStore.set("admin_session", process.env.ADMIN_PASSWORD!, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 24, // 1일
  });

  return { success: true };
}

export async function isAuthenticated() {
  const cookieStore = await cookies();
  return cookieStore.get("admin_session")?.value === process.env.ADMIN_PASSWORD;
}

export async function deleteNews(id: number) {
  if (!(await isAuthenticated())) throw new Error("Unauthorized");

  const supabase = await createClient(await cookies());

  // 오디오 파일도 스토리지에서 삭제
  const { data: news } = await supabase
    .from("audio_news")
    .select("audio_url")
    .eq("id", id)
    .single();

  if (news?.audio_url) {
    const fileName = news.audio_url.split("/").pop();
    if (fileName) {
      await supabase.storage.from("audio-news").remove([fileName]);
    }
  }

  const { error } = await supabase.from("audio_news").delete().eq("id", id);
  if (error) throw error;

  revalidatePath("/admin");
  revalidatePath("/");
}
