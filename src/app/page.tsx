// app/page.tsx
import { NewsCardList } from "@/app/components/news-card-list";

export default async function Home() {
  return (
    <main>
      <NewsCardList />
    </main>
  );
}
