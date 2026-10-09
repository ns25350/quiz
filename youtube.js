export function youtubeVideoId(value) {
  const text = String(value || "").trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const id =
      url.hostname === "youtu.be"
        ? url.pathname.split("/")[1]
        : [
              "youtube.com",
              "www.youtube.com",
              "m.youtube.com",
              "www.youtube-nocookie.com",
            ].includes(url.hostname)
          ? url.searchParams.get("v") ||
            (/^\/(?:embed|shorts|live)\//.test(url.pathname)
              ? url.pathname.split("/")[2]
              : "")
          : "";
    return /^[\w-]{11}$/.test(id || "") ? id : null;
  } catch {
    return null;
  }
}

export async function fetchYouTubeTitle(id, fetcher = fetch) {
  if (!/^[\w-]{11}$/.test(id)) throw Error("YouTube動画URLが不正です");
  const url = new URL("https://www.youtube.com/oembed");
  url.searchParams.set("url", `https://www.youtube.com/watch?v=${id}`);
  url.searchParams.set("format", "json");
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw Error("動画タイトルを取得できません");
  const data = await response.json();
  if (typeof data.title !== "string" || !data.title.trim())
    throw Error("動画タイトルがありません");
  return data.title.trim().slice(0, 500);
}
