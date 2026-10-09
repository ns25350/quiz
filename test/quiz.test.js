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
test("rooms, host permissions, ranked buzzes, scoring and question visibility", async (t) => {
  const { http, io } = createApp();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${http.address().port}`;
  const a = client(url),
    b = client(url),
    c = client(url),
    d = client(url);
  t.after(async () => {
    a.disconnect();
    b.disconnect();
    c.disconnect();
    d.disconnect();
    await new Promise((r) => io.close(r));
  });
  await Promise.all(
    [a, b, c, d].map((s) => new Promise((r) => s.on("connect", r))),
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
  update = next(d);
  await emit(d, "join", { name: "参加者3", code });
  await update;
  for (const event of ["start", "next", "reset", "pause", "reveal"])
    assert.equal((await emit(b, event)).ok, false);
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
  assert.equal((await emit(a, "buzz")).ok, false);
  update = next(a, (s) => s.buzzes.length === 2);
  const results = await Promise.all([emit(b, "buzz"), emit(c, "buzz")]);
  s = await update;
  assert.equal(s.buzzes.length, 2);
  assert.equal(new Set(s.buzzes.map((b) => b.id)).size, 2);
  assert.deepEqual(new Set(s.buzzes.map((p) => p.id)), new Set([b.id, c.id]));
  assert.equal(s.phase, "buzzed");
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(s.elapsed, s.buzzes[0].ms);
  assert.ok(s.buzzes[1].ms >= s.buzzes[0].ms);
  const frozenElapsed = s.elapsed;
  assert.equal((await emit(b, "buzz")).ok, true);
  assert.ok(s.elapsed >= 0);
  update = next(a);
  await emit(a, "score", { id: s.buzzes[0].id, delta: 1 });
  s = await update;
  assert.equal(s.players.find((p) => p.id === s.buzzes[0].id).score, 1);
  update = next(b, (s) => s.revealed);
  await emit(a, "reveal");
  s = await update;
  assert.equal(s.question.answer, "秘密の答え");
  assert.equal(s.buzzes.length, 2);
  assert.equal(s.elapsed, frozenElapsed);
  assert.equal((await emit(d, "buzz")).ok, false);
  update = next(b, (s) => s.index === 1);
  await emit(a, "next");
  s = await update;
  assert.equal(s.index, 1);
  assert.equal(s.phase, "ready");
  assert.equal(s.revealed, false);
  assert.equal(s.question.answer, "");
  assert.equal(s.buzzes.length, 0);
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
  assert.equal((await emit(a, "buzz")).ok, false);
  u = next(a, (s) => s.round === 2 && s.phase === "ready");
  await emit(a, "next");
  let round = await u;
  assert.equal(round.elapsed, 0);
  assert.equal(round.buzzes.length, 0);
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

test("late buzzes keep the first timer frozen; reset clears ranks and pause blocks pressing", async (t) => {
  const { http, io } = createApp();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${http.address().port}`;
  const operator = client(url),
    first = client(url),
    second = client(url);
  t.after(async () => {
    operator.disconnect();
    first.disconnect();
    second.disconnect();
    await new Promise((r) => io.close(r));
  });
  await Promise.all(
    [operator, first, second].map(
      (s) => new Promise((r) => s.on("connect", r)),
    ),
  );
  let u = next(operator);
  await emit(operator, "create", { name: "運営", mode: "button" });
  const { code } = await u;
  await emit(first, "join", { name: "1人目", code });
  await emit(second, "join", { name: "2人目", code });
  await emit(operator, "start");
  u = next(operator, (s) => s.buzzes.length === 1);
  await emit(first, "buzz");
  const initial = await u;
  await new Promise((r) => setTimeout(r, 30));
  u = next(operator, (s) => s.buzzes.length === 2);
  await emit(second, "buzz");
  const later = await u;
  assert.equal(later.elapsed, initial.elapsed);
  assert.equal(later.buzzes[0].id, first.id);
  assert.equal(later.buzzes[1].id, second.id);
  assert.ok(later.buzzes[1].ms >= later.buzzes[0].ms + 25);
  await emit(first, "buzz");
  u = next(operator, (s) => s.phase === "ready");
  await emit(operator, "reset");
  const reset = await u;
  assert.equal(reset.buzzes.length, 0);
  assert.equal(reset.elapsed, 0);
  assert.equal((await emit(first, "buzz")).ok, false);
  await emit(operator, "start");
  await emit(operator, "pause");
  assert.equal((await emit(second, "buzz")).ok, false);
});
