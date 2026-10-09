import test from "node:test";
import assert from "node:assert/strict";
import { io as client } from "socket.io-client";
import { createApp, questionsFromCsv } from "../server.js";
const emit = (s, event, data = {}) =>
  new Promise((resolve) => s.emit(event, data, resolve));
const next = (s, predicate = () => true) =>
  new Promise((resolve) => {
    const listener = (state) => {
      if (predicate(state)) {
        s.off("state", listener);
        resolve(state);
      }
    };
    s.on("state", listener);
  });
test("CSV handles Japanese headers, commas and start time", () => {
  assert.deepEqual(
    questionsFromCsv(
      '問題,答え,URL,開始秒\n"曲,名",答え,https://youtu.be/abcdefghijk,12',
    ),
    [
      {
        title: "曲,名",
        answer: "答え",
        url: "https://youtu.be/abcdefghijk",
        start: 12,
      },
    ],
  );
});
test("rooms, host permissions, atomic buzz, scoring and question visibility", async (t) => {
  const { http, io } = createApp();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${http.address().port}`;
  const a = client(url),
    b = client(url),
    c = client(url);
  t.after(async () => {
    a.disconnect();
    b.disconnect();
    c.disconnect();
    await new Promise((r) => io.close(r));
  });
  await Promise.all(
    [a, b, c].map((s) => new Promise((r) => s.on("connect", r))),
  );
  assert.equal((await fetch(url + "/health").then((r) => r.json())).ok, true);
  assert.match(await fetch(url).then((r) => r.text()), /ポン！/);
  let update = next(a);
  assert.equal(
    (await emit(a, "create", { name: "司会", mode: "normal" })).ok,
    true,
  );
  let s = await update;
  const code = s.code;
  update = next(b);
  await emit(b, "join", { name: "参加者", code });
  await update;
  update = next(c);
  await emit(c, "join", { name: "参加者2", code });
  await update;
  assert.equal((await emit(b, "start")).ok, false);
  update = next(b);
  await emit(a, "import", {
    csv: "title,answer,url,start\n問題,秘密の答え,,0\n次の問題,答え2,,0",
  });
  s = await update;
  assert.equal(s.question.answer, "");
  assert.equal(s.questions, undefined);
  update = next(a);
  await emit(a, "start");
  s = await update;
  assert.equal(s.phase, "playing");
  assert.equal(typeof s.startedAt, "number");
  update = next(a);
  const results = await Promise.all([emit(b, "buzz"), emit(c, "buzz")]);
  s = await update;
  assert.equal(s.buzzes.length, 1);
  assert.equal(s.phase, "buzzed");
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(s.elapsed >= 0);
  update = next(a);
  await emit(a, "score", { id: s.buzzes[0].id, delta: 1 });
  s = await update;
  assert.equal(s.players.find((p) => p.id === s.buzzes[0].id).score, 1);
  update = next(b, (s) => s.revealed);
  await emit(a, "reveal");
  s = await update;
  assert.equal(s.question.answer, "秘密の答え");
  update = next(b, (s) => s.index === 1);
  await emit(a, "next");
  s = await update;
  assert.equal(s.index, 1);
  assert.equal(s.phase, "ready");
  assert.equal(s.revealed, false);
  assert.equal(s.question.answer, "");
  update = next(b, (s) => s.hostId === b.id);
  await emit(a, "leave");
  s = await update;
  assert.equal(s.hostId, b.id);
});
test("button mode starts without questions; intro pause, resume and reset preserve timing", async (t) => {
  const { http, io } = createApp();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const a = client(`http://127.0.0.1:${http.address().port}`);
  t.after(async () => {
    a.disconnect();
    await new Promise((r) => io.close(r));
  });
  await new Promise((r) => a.on("connect", r));
  let u = next(a);
  await emit(a, "create", { name: "司会", mode: "button" });
  await u;
  u = next(a, (s) => s.phase === "playing");
  assert.equal((await emit(a, "start")).ok, true);
  await u;
  u = next(a, (s) => s.mode === "intro");
  await emit(a, "create", { name: "司会", mode: "intro" });
  await u;
  assert.equal((await emit(a, "start")).ok, false);
  u = next(a, (s) => s.count === 1);
  await emit(a, "import", {
    questions: [
      {
        title: "曲",
        answer: "答え",
        url: "https://youtu.be/jNQXAC9IVRw",
        start: 5,
      },
    ],
  });
  await u;
  u = next(a, (s) => s.phase === "playing");
  await emit(a, "start");
  await u;
  await new Promise((r) => setTimeout(r, 25));
  u = next(a, (s) => s.phase === "paused");
  await emit(a, "pause");
  let s = await u;
  assert.ok(s.elapsed >= 20);
  const elapsed = s.elapsed;
  u = next(a, (s) => s.phase === "playing");
  await emit(a, "start");
  s = await u;
  assert.ok(s.serverNow - s.startedAt >= elapsed);
  u = next(a, (s) => s.phase === "ready");
  await emit(a, "reset");
  s = await u;
  assert.equal(s.elapsed, 0);
  assert.equal(s.buzzes.length, 0);
});
