const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export function youtubePlaylistId(value) {
  if (typeof value !== "string") return null;
  let id = value.trim();
  if (id.includes(":")) {
    try {
      const url = new URL(id);
      if (
        url.protocol !== "https:" ||
        !youtubeHosts.has(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        return null;
      id = url.searchParams.get("list") || "";
    } catch {
      return null;
    }
  }
  return /^[\w-]{10,150}$/.test(id) ? id : null;
}

// Read a JSON object from YouTube's script without executing any remote code.
function jsonObject(text, start) {
  if (text[start] !== "{") return null;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function parsePlaylistPage(html) {
  const marker =
    /(?:\b(?:var\s+)?ytInitialData|window\["ytInitialData"\])\s*=\s*/g;
  let match, data;
  while ((match = marker.exec(html)) && !data)
    data = jsonObject(html, marker.lastIndex);
  if (!data)
    throw Error(
      "YouTubeの動画一覧を読み取れません。公開設定を確認して再試行してください",
    );
  const config = {},
    configMarker = /\bytcfg\.set\(\s*/g;
  while ((match = configMarker.exec(html)))
    Object.assign(config, jsonObject(html, configMarker.lastIndex) || {});
  return { data, config };
}

const textOf = (value) =>
  value?.simpleText || value?.runs?.map((r) => r.text || "").join("") || "";
export function playlistEntries(data) {
  const items = [];
  let continuation = null,
    skipped = 0,
    unavailable = false;
  const stack = [data];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    const video = value.playlistVideoRenderer;
    if (video) {
      const title = textOf(video.title).trim();
      if (
        !/^[\w-]{11}$/.test(video.videoId || "") ||
        video.isPlayable === false ||
        !title ||
        /^(?:\[)?(?:Private|Deleted) video(?:\])?$/i.test(title)
      )
        skipped++;
      else items.push({ id: video.videoId, title });
      continue;
    }
    if (value.alertRenderer?.type === "ERROR") unavailable = true;
    if (value.continuationItemRenderer) {
      const node = value.continuationItemRenderer;
      continuation ||=
        node.continuationEndpoint?.continuationCommand?.token ||
        node.button?.buttonRenderer?.command?.continuationCommand?.token;
      if (!continuation)
        throw Error("動画一覧の続きが取得できません。再試行してください");
      continue;
    }
    // Push in reverse order to retain YouTube's original playlist order.
    stack.push(...Object.values(value).reverse());
  }
  if (unavailable && !items.length)
    throw Error(
      "プレイリストが見つかりません。公開・限定公開のURLを確認してください",
    );
  return { items, continuation, skipped };
}

const question = ({ id, title }) => ({
  title: title.slice(0, 500),
  answer: title.slice(0, 500),
  videoTitle: title.slice(0, 500),
  titleStatus: "ready",
  url: `https://www.youtube.com/watch?v=${id}`,
  start: 0,
});

export async function fetchYouTubePlaylist(
  value,
  { fetcher = fetch, apiKey = process.env.YOUTUBE_API_KEY, limit = 500 } = {},
) {
  const id = youtubePlaylistId(value);
  if (!id) throw Error("YouTubeのプレイリストURL（list=…）を入力してください");
  const signal = AbortSignal.timeout(30000);
  const read = async (url, options = {}) => {
    try {
      const response = await fetcher(url, {
        ...options,
        signal,
        redirect: "error",
      });
      if (!response.ok) throw Error("unavailable");
      const text = await response.text();
      if (text.length > 10000000) throw Error("response too large");
      return text;
    } catch {
      throw Error(
        apiKey
          ? "YouTube APIから取得できません。公開設定・APIキー・利用上限を確認してください"
          : "YouTubeに接続できません。再試行してください。続く場合は運営サーバーにYouTube APIキーを設定できます",
      );
    }
  };
  const readJson = async (url, options) => {
    const body = await read(url, options);
    try {
      return JSON.parse(body);
    } catch {
      throw Error("YouTubeの動画一覧を読み取れません。再試行してください");
    }
  };
  let items = [],
    skipped = 0,
    nextToken = null;
  const seenTokens = new Set();
  if (apiKey) {
    do {
      const url = new URL(
        "https://www.googleapis.com/youtube/v3/playlistItems",
      );
      url.search = new URLSearchParams({
        part: "snippet",
        playlistId: id,
        maxResults: "50",
        key: apiKey,
        ...(nextToken ? { pageToken: nextToken } : {}),
      }).toString();
      const data = await readJson(url);
      if (!Array.isArray(data.items))
        throw Error("YouTubeの動画一覧を読み取れません");
      for (const { snippet } of data.items) {
        const videoId = snippet?.resourceId?.videoId,
          title = snippet?.title;
        if (
          !/^[\w-]{11}$/.test(videoId || "") ||
          typeof title !== "string" ||
          !title.trim() ||
          /^(Private|Deleted) video$/i.test(title)
        )
          skipped++;
        else items.push({ id: videoId, title });
      }
      nextToken = data.nextPageToken || null;
      if (nextToken && seenTokens.has(nextToken))
        throw Error("動画一覧の続きが取得できません");
      seenTokens.add(nextToken);
    } while (nextToken && items.length < limit);
  } else {
    const html = await read(
      `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}&hl=en`,
      {
        headers: {
          "accept-language": "en-US,en;q=0.8",
          cookie: "SOCS=CAI",
          "user-agent": "Mozilla/5.0",
        },
      },
    );
    const { data, config } = parsePlaylistPage(html);
    let page = playlistEntries(data);
    for (let pages = 0; ; pages++) {
      items.push(...page.items);
      skipped += page.skipped;
      nextToken = page.continuation;
      if (!nextToken || items.length >= limit) break;
      if (pages >= 50 || seenTokens.has(nextToken))
        throw Error("動画一覧の続きが取得できません。再試行してください");
      seenTokens.add(nextToken);
      if (!config.INNERTUBE_API_KEY || !config.INNERTUBE_CONTEXT)
        throw Error(
          "動画一覧の続きが取得できません。YouTube APIキーの設定で取得できます",
        );
      const url = new URL("https://www.youtube.com/youtubei/v1/browse");
      url.searchParams.set("key", config.INNERTUBE_API_KEY);
      const context = {
        ...config.INNERTUBE_CONTEXT,
        client: { ...config.INNERTUBE_CONTEXT.client, hl: "en" },
      };
      const continuationData = await readJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ context, continuation: nextToken }),
      });
      page = playlistEntries(continuationData);
      if (!page.items.length && !page.skipped && !page.continuation)
        throw Error("動画一覧の続きが取得できません。再試行してください");
    }
  }
  if (!items.length)
    throw Error(
      "再生可能な動画がありません。公開・限定公開のプレイリストを指定してください",
    );
  return {
    questions: items.slice(0, limit).map(question),
    skipped,
    truncated: items.length > limit || !!nextToken,
  };
}
