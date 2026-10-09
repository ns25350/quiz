import test from "node:test";
import assert from "node:assert/strict";
import { io as client } from "socket.io-client";
import { createApp } from "../server.js";
import { fetchYouTubeTitle, youtubeVideoId } from "../youtube.js";
const emit = (socket, event, data = {}) =>
  new Promise((resolve) => socket.emit(event, data, resolve));
const next = (socket, predicate) =>
  new Promise((resolve) => {
    const listener = (s) => {
      if (predicate(s)) {
        socket.off("state", listener);
        resolve(s);
      }
    };
    socket.on("state", listener);
  });

test("YouTube IDs and oEmbed titles are validated using a fixed trusted endpoint", async () => {
  for (const value of [
    "jNQXAC9IVRw",
    "https://youtu.be/jNQXAC9IVRw?t=2",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/shorts/jNQXAC9IVRw",
  ])
    assert.equal(youtubeVideoId(value), "jNQXAC9IVRw");
  for (const value of [
    "https://evil.example/watch?v=jNQXAC9IVRw",
    "javascript:alert(1)",
    "https://www.youtube.com/watch?v=bad",
    "https://youtube.com.evil.example/watch?v=jNQXAC9IVRw",
  ])
    assert.equal(youtubeVideoId(value), null);
  const title = await fetchYouTubeTitle("jNQXAC9IVRw", async (url, options) => {
    assert.equal(url.origin, "https://www.youtube.com");
    assert.equal(url.pathname, "/oembed");
    assert.equal(options.redirect, "error");
    return {
      ok: true,
      json: async () => ({ title: "  日本語の動画タイトル & 曲名  " }),
    };
  });
  assert.equal(title, "日本語の動画タイトル & 曲名");
  await assert.rejects(
    fetchYouTubeTitle("bad", () => assert.fail("invalid IDs must not fetch")),
  );
  await assert.rejects(
    fetchYouTubeTitle("jNQXAC9IVRw", async () => ({ ok: false })),
  );
});

async function fixture(t, fetchVideoTitle) {
  const { http, io } = createApp({ fetchVideoTitle });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${http.address().port}`;
  const host = client(url),
    player = client(url);
  t.after(async () => {
    host.disconnect();
    player.disconnect();
    await new Promise((r) => io.close(r));
  });
  await Promise.all(
    [host, player].map((s) => new Promise((r) => s.on("connect", r))),
  );
  let state;
  host.on("state", (s) => {
    state = s;
  });
  await emit(host, "create", { name: "運営", mode: "intro" });
  await emit(player, "join", { name: "回答者", code: state.code });
  return { host, player, state: () => state };
}

test(
  "CSV titles automatically become answers, duplicate videos share a lookup, and players only see revealed answers",
  { timeout: 10000 },
  async (t) => {
    let lookups = 0;
    const f = await fixture(t, async () => {
      lookups++;
      return "自動取得した動画タイトル";
    });
    const ready = next(
      f.host,
      (s) =>
        s.questions?.length === 2 &&
        s.questions.every((q) => q.titleStatus === "ready"),
    );
    await emit(f.host, "import", {
      csv: "title,answer,url,start\n曲1,古い答え,https://youtu.be/jNQXAC9IVRw,5\n曲2,,https://www.youtube.com/watch?v=jNQXAC9IVRw,10",
    });
    const state = await ready;
    assert.equal(state.question.answer, "自動取得した動画タイトル");
    assert.equal(lookups, 1);
    const hidden = next(f.player, (s) => s.settings.showTimer === false);
    await emit(f.host, "settings", { settings: { showTimer: false } });
    assert.equal((await hidden).question.answer, "");
    const revealed = next(f.player, (s) => s.revealed);
    await emit(f.host, "reveal");
    assert.equal((await revealed).question.answer, "自動取得した動画タイトル");
  },
);

test(
  "failed metadata can be retried and embedded titles require host permission and the current video/round",
  { timeout: 10000 },
  async (t) => {
    let failing = true;
    const f = await fixture(t, async () => {
      if (failing) throw Error("offline");
      return "再取得したタイトル";
    });
    let u = next(f.host, (s) => s.question?.titleStatus === "failed");
    await emit(f.host, "import", {
      questions: [
        {
          title: "曲",
          url: "https://youtu.be/jNQXAC9IVRw",
          answer: "手動の答え",
        },
      ],
    });
    let s = await u;
    assert.equal(s.question.answer, "手動の答え");
    const data = {
      videoId: "jNQXAC9IVRw",
      title: "埋め込みから取得",
      roundId: s.roundId,
    };
    assert.equal((await emit(f.player, "videoTitle", data)).ok, false);
    assert.equal(
      (await emit(f.host, "videoTitle", { ...data, videoId: "abcdefghijk" }))
        .ok,
      false,
    );
    assert.equal(
      (await emit(f.host, "videoTitle", { ...data, roundId: "stale" })).ok,
      false,
    );
    u = next(f.host, (s) => s.question?.titleStatus === "ready");
    assert.equal((await emit(f.host, "videoTitle", data)).ok, true);
    assert.equal((await u).question.answer, "埋め込みから取得");
    u = next(f.host, (s) => s.question?.titleStatus === "failed");
    await emit(f.host, "import", {
      questions: [{ title: "曲", url: "https://youtu.be/jNQXAC9IVRw" }],
    });
    await u;
    failing = false;
    u = next(f.host, (s) => s.question?.titleStatus === "ready");
    await emit(f.host, "retryTitles");
    assert.equal((await u).question.answer, "再取得したタイトル");
  },
);

test(
  "a completed lookup cannot overwrite questions imported later",
  { timeout: 10000 },
  async (t) => {
    let release;
    const f = await fixture(t, (id) =>
      id === "jNQXAC9IVRw"
        ? new Promise((r) => {
            release = r;
          })
        : Promise.resolve("新しい動画"),
    );
    await emit(f.host, "import", {
      questions: [{ title: "旧", url: "https://youtu.be/jNQXAC9IVRw" }],
    });
    const u = next(
      f.host,
      (s) => s.question?.titleStatus === "ready" && s.question.title === "新",
    );
    await emit(f.host, "import", {
      questions: [{ title: "新", url: "https://youtu.be/abcdefghijk" }],
    });
    release("古い動画");
    const s = await u;
    assert.equal(s.question.answer, "新しい動画");
    assert.equal(s.questions.length, 1);
  },
);
