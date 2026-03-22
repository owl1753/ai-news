"use server";

export const generate = async () => {
  await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/cron/fetch-news`, {
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
    },
  });
};
