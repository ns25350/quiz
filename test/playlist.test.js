import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchYouTubePlaylist,
  parsePlaylistPage,
  playlistEntries,
  youtubePlaylistId,
} from "../playlist.js";
import { io as client } from "socket.io-client";
import { createApp } from "../server.js";

const list = "PLtest0123456789",
  firstId = "jNQXAC9IVRw",
  secondId = "abcdefghijk";
const video = (id, title, isPlayable = true) => ({
  playlistVideoRenderer: {
    videoId: id,
    title: { runs: [{ text: title }] },
    isPlayable,
  },
});
const continuation = (token) => ({
  continuationItemRenderer: {
    continuationEndpoint: { continuationCommand: { token } },
  },
});
const page = (items) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    itemSectionRenderer: {
                      contents: [
                        { playlistVideoListRenderer: { contents: items } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
});
const html = (items) =>
  `<script>ytcfg.set({"OTHER_SETTING":1});ytcfg.set(${JSON.stringify({ INNERTUBE_API_KEY: "public-client-key", INNERTUBE_CONTEXT: { client: { clientName: "WEB", clientVersion: "test" } } })});var ytInitialData = ${JSON.stringify(page(items))};</script>`;

test("playlist IDs require trusted YouTube URLs and script JSON is parsed without execution", () => {
  assert.equal(
    youtubePlaylistId(`https://www.youtube.com/playlist?list=${list}`),
    list,
  );
  assert.equal(
    youtubePlaylistId(`https://youtu.be/${firstId}?list=${list}`),
    list,
  );
  assert.equal(youtubePlaylistId(list), list);
  for (const value of [
    `https://evil.example/playlist?list=${list}`,
    `http://127.0.0.1/?list=${list}`,
    `https://www.youtube.com@evil.example/?list=${list}`,
    `https://user@www.youtube.com/?list=${list}`,
    "javascript:alert(1)",
    "https://youtube.com/watch?v=only-video",
    {},
    "",
  ])
    assert.equal(youtubePlaylistId(value), null);
  const title = '曲 "引用" { } \\ 新曲';
  const parsed = parsePlaylistPage(html([video(firstId, title)]));
  assert.equal(playlistEntries(parsed.data).items[0].title, title);
  assert.equal(parsed.config.INNERTUBE_API_KEY, "public-client-key");
  assert.equal(parsed.config.OTHER_SETTING, 1);
  assert.throws(
    () => parsePlaylistPage("<script>ytInitialData = malicious()</script>"),
    /読み取れません/,
  );
});

test("anonymous import follows continuation pages in order and sets answers from video titles", async () => {
  const calls = [];
  const result = await fetchYouTubePlaylist(list, {
    apiKey: "",
    fetcher: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(
        calls.length === 1
          ? html([
              video(firstId, "曲1"),
              video("private1234", "Private video", false),
              continuation("page2"),
            ])
          : JSON.stringify({
              onResponseReceivedActions: [
                {
                  appendContinuationItemsAction: {
                    continuationItems: [video(secondId, "曲2")],
                  },
                },
              ],
            }),
      );
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).hostname, "www.youtube.com");
  assert.equal(JSON.parse(calls[1].options.body).continuation, "page2");
  assert.deepEqual(
    result.questions.map((q) => q.answer),
    ["曲1", "曲2"],
  );
  assert.equal(
    result.questions[1].url,
    `https://www.youtube.com/watch?v=${secondId}`,
  );
  assert.equal(result.questions[1].titleStatus, "ready");
  assert.equal(result.skipped, 1);
  assert.equal(result.truncated, false);
});

test("import explicitly reports a cap and refuses incomplete or unavailable playlists", async () => {
  const capped = await fetchYouTubePlaylist(list, {
    apiKey: "",
    limit: 1,
    fetcher: async () =>
      new Response(
        html([
          video(firstId, "曲1"),
          video(secondId, "曲2"),
          continuation("more"),
        ]),
      ),
  });
  assert.equal(capped.questions.length, 1);
  assert.equal(capped.truncated, true);
  const many = await fetchYouTubePlaylist(list, {
    apiKey: "",
    fetcher: async () =>
      new Response(
        html(
          Array.from({ length: 501 }, (_, index) =>
            video(firstId, `曲${index + 1}`),
          ),
        ),
      ),
  });
  assert.equal(many.questions.length, 500);
  assert.equal(many.questions[499].answer, "曲500");
  assert.equal(many.truncated, true);
  const fails = [
    async () => new Response(html([])),
    async () => new Response("consent/login page"),
    async () => new Response("blocked", { status: 403 }),
    async () =>
      new Response(
        html([
          video(firstId, "曲1"),
          { continuationItemRenderer: { unknownCommand: {} } },
        ]),
      ),
  ];
  for (const fetcher of fails)
    await assert.rejects(fetchYouTubePlaylist(list, { apiKey: "", fetcher }));
  let count = 0;
  await assert.rejects(
    fetchYouTubePlaylist(list, {
      apiKey: "",
      fetcher: async () =>
        new Response(
          ++count === 1
            ? html([video(firstId, "曲1"), continuation("more")])
            : JSON.stringify({ error: { code: 403 } }),
        ),
    }),
    /続きが取得できません/,
  );
});

test("configured official API paginates safely and never exposes its key in errors", async () => {
  const calls = [];
  const result = await fetchYouTubePlaylist(list, {
    apiKey: "private-test-key",
    fetcher: async (url) => {
      calls.push(new URL(url));
      return Response.json(
        calls.length === 1
          ? {
              items: [
                { snippet: { resourceId: { videoId: firstId }, title: "曲1" } },
              ],
              nextPageToken: "next",
            }
          : {
              items: [
                {
                  snippet: { resourceId: { videoId: secondId }, title: "曲2" },
                },
              ],
            },
      );
    },
  });
  assert.equal(calls[0].hostname, "www.googleapis.com");
  assert.equal(calls[1].searchParams.get("pageToken"), "next");
  assert.deepEqual(
    result.questions.map((q) => q.answer),
    ["曲1", "曲2"],
  );
  await assert.rejects(
    fetchYouTubePlaylist(list, {
      apiKey: "private-test-key",
      fetcher: async () => {
        throw Error("private-test-key");
      },
    }),
    (error) =>
      /API/.test(error.message) && !error.message.includes("private-test-key"),
  );
});

test(
  "socket playlist imports enforce host access, preserve old questions on failure, and reject stale async results",
  { timeout: 10000 },
  async (t) => {
    let complete,
      fail = false;
    const { http, io } = createApp({
      fetchVideoTitle: async () => "曲名",
      fetchPlaylist: async () => {
        if (fail) throw Error("プレイリストが非公開です");
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${http.address().port}`;
    const host = client(url),
      guest = client(url);
    t.after(async () => {
      host.disconnect();
      guest.disconnect();
      await new Promise((resolve) => io.close(resolve));
    });
    await Promise.all(
      [host, guest].map(
        (s) => new Promise((resolve) => s.once("connect", resolve)),
      ),
    );
    let state;
    host.on("state", (s) => {
      state = s;
    });
    const emit = (s, event, data = {}) =>
      new Promise((resolve, reject) =>
        s
          .timeout(3000)
          .emit(event, data, (error, result) =>
            error ? reject(error) : resolve(result),
          ),
      );
    await emit(host, "create", { name: "運営", mode: "intro" });
    await emit(guest, "join", { name: "回答者", code: state.code });
    await emit(host, "import", {
      questions: [{ title: "元の曲", url: firstId }],
    });
    const input = { url: `https://www.youtube.com/playlist?list=${list}` };
    assert.equal((await emit(guest, "playlist", input)).ok, false);
    assert.equal(
      (await emit(host, "playlist", { url: "https://evil.example" })).ok,
      false,
    );
    fail = true;
    assert.equal((await emit(host, "playlist", input)).ok, false);
    assert.equal(state.questions[0].title, "元の曲");
    fail = false;
    const pending = emit(host, "playlist", input);
    const duplicate = await emit(host, "playlist", input);
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /取り込み中/);
    const imported = {
      questions: [
        {
          title: "新曲",
          answer: "新曲",
          url: firstId,
          start: 0,
          titleStatus: "ready",
        },
      ],
      skipped: 1,
      truncated: false,
    };
    complete(imported);
    assert.deepEqual(await pending, {
      ok: true,
      count: 1,
      skipped: 1,
      truncated: false,
    });
    assert.equal(state.question.answer, "新曲");
    const stale = emit(host, "playlist", input);
    await emit(host, "reset");
    complete(imported);
    assert.equal((await stale).ok, false);
    assert.equal(state.question.answer, "新曲");
    await emit(host, "start");
    assert.equal((await emit(host, "playlist", input)).ok, false);
  },
);
