"use client";

import { deleteNews } from "./actions";
import { useTransition } from "react";

export function DeleteButton({ id }: { id: number }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
      disabled={pending}
      onClick={() => {
        if (!confirm("정말 삭제하시겠습니까?")) return;
        startTransition(() => deleteNews(id));
      }}
    >
      {pending ? "삭제 중..." : "삭제"}
    </button>
  );
}
