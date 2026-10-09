import test from "node:test";
import assert from "node:assert/strict";
import { io as client } from "socket.io-client";
import { createApp } from "../server.js";

const emit = (socket, event, data = {}) =>
  new Promise((resolve) => socket.emit(event, data, resolve));
test(
  "survival damage remains after the player who dealt it leaves",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { rule: "survival" });
    await f.answer(f.a, true);
    await emit(f.a, "leave");
    assert.equal(f.player(f.b).lives, 2);
    assert.equal(f.player(f.c).lives, 2);
    assert.equal(f.state().game.status, "playing");
  },
);
test(
  "survival waits for at least two contestants",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { rule: "survival" });
    await emit(f.b, "leave");
    await emit(f.c, "leave");
    assert.equal((await emit(f.host, "start")).ok, false);
    assert.equal(f.state().phase, "ready");
    assert.equal(f.state().game.status, "waiting");
  },
);
async function fixture(t, settings) {
  const { http, io } = createApp();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${http.address().port}`;
  const sockets = [
    client(url),
    client(url),
    client(url),
    client(url),
    client(url),
  ];
  t.after(async () => {
    for (const s of sockets) s.disconnect();
    await new Promise((r) => io.close(r));
  });
  await Promise.all(sockets.map((s) => new Promise((r) => s.on("connect", r))));
  const [host, a, b, c, late] = sockets;
  let state;
  host.on("state", (s) => {
    state = s;
  });
  await emit(host, "create", { name: "運営", mode: "button" });
  const code = state.code;
  for (const [index, socket] of [a, b, c].entries())
    await emit(socket, "join", { name: `回答者${index + 1}`, code });
  assert.equal((await emit(host, "settings", { settings })).ok, true);
  async function answer(socket, correct, advance = true) {
    if (advance && state.phase !== "ready")
      assert.equal((await emit(host, "next")).ok, true);
    assert.equal((await emit(host, "start")).ok, true);
    assert.equal(
      (await emit(socket, "buzz", { roundId: state.roundId })).ok,
      true,
    );
    const request = { id: socket.id, correct, roundId: state.roundId };
    assert.equal((await emit(host, "judge", request)).ok, true);
    return request;
  }
  return {
    host,
    a,
    b,
    c,
    late,
    code,
    state: () => state,
    answer,
    player: (socket) => state.players.find((p) => p.id === socket.id),
  };
}

test(
  "7 correct wins; corrections reopen the game and new-game resets all progress",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { rule: "seven-three" });
    let request;
    for (let i = 0; i < 7; i++) request = await f.answer(f.a, true);
    assert.equal(f.player(f.a).correct, 7);
    assert.equal(f.player(f.a).status, "won");
    assert.equal(f.state().game.status, "finished");
    assert.deepEqual(
      f.state().game.winners.map((p) => p.id),
      [f.a.id],
    );
    assert.equal((await emit(f.host, "judge", request)).ok, true);
    assert.equal(f.player(f.a).correct, 7);
    for (const event of ["start", "next"])
      assert.equal((await emit(f.host, event)).ok, false);
    assert.equal((await emit(f.b, "buzz")).ok, false);
    await emit(f.late, "join", { name: "後から参加", code: f.code });
    assert.equal(f.player(f.late).status, "spectator");
    await emit(f.host, "score", { id: f.a.id, delta: 1 });
    await emit(f.host, "judge", { ...request, correct: false });
    assert.equal(f.player(f.a).score, 7);
    assert.equal(f.player(f.a).correct, 6);
    assert.equal(f.player(f.a).wrong, 1);
    assert.equal(f.player(f.a).status, "active");
    assert.equal(f.state().game.status, "playing");
    await emit(f.host, "reset");
    assert.equal(f.player(f.a).correct, 6);
    assert.equal((await emit(f.b, "restartGame")).ok, false);
    await emit(f.host, "restartGame");
    for (const p of f.state().players) {
      assert.equal(p.score, 0);
      assert.equal(p.correct, 0);
      assert.equal(p.wrong, 0);
    }
    assert.equal(f.player(f.late).status, "active");
    assert.equal(f.state().game.status, "waiting");
    assert.equal(f.state().round, 1);
  },
);

test(
  "three wrong answers eliminate a player; correcting the judgment restores eligibility",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { rule: "seven-three" });
    let request;
    for (let i = 0; i < 3; i++) request = await f.answer(f.a, false);
    assert.equal(f.player(f.a).wrong, 3);
    assert.equal(f.player(f.a).status, "eliminated");
    assert.equal((await emit(f.a, "buzz")).ok, false);
    await emit(f.host, "judge", { ...request, correct: true });
    assert.equal(f.player(f.a).status, "active");
    assert.equal(f.player(f.a).wrong, 2);
    assert.equal(f.player(f.a).correct, 1);
    await emit(f.host, "next");
    await emit(f.host, "start");
    assert.equal((await emit(f.a, "buzz")).ok, true);
  },
);

test(
  "survival damage is reversible, excludes the host, and declares the last survivor",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, {
      rule: "survival",
      startingLives: 2,
      lifeDamage: 1,
      wrongLifeLoss: 1,
    });
    const request = await f.answer(f.a, true);
    assert.deepEqual(
      [f.player(f.a).lives, f.player(f.b).lives, f.player(f.c).lives],
      [2, 1, 1],
    );
    assert.equal(f.player(f.host).lives, 2);
    await emit(f.host, "judge", request);
    assert.equal(f.player(f.b).lives, 1);
    await emit(f.host, "judge", { ...request, correct: false });
    assert.deepEqual(
      [f.player(f.a).lives, f.player(f.b).lives, f.player(f.c).lives],
      [1, 2, 2],
    );
    await f.answer(f.b, true);
    assert.equal(f.player(f.a).lives, 0);
    assert.equal(f.player(f.a).status, "eliminated");
    assert.equal((await emit(f.a, "buzz")).ok, false);
    const last = await f.answer(f.b, true);
    assert.equal(f.player(f.b).status, "won");
    assert.equal(f.player(f.c).lives, 0);
    assert.equal(f.state().game.status, "finished");
    await emit(f.host, "judge", { ...last, correct: false });
    assert.equal(f.state().game.status, "playing");
    assert.equal(f.player(f.a).lives, 0);
    assert.equal(f.player(f.b).lives, 1);
    assert.equal(f.player(f.c).lives, 1);
  },
);

test(
  "late survival entrants have full lives; rule settings are atomic and locked during a match",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, {
      rule: "survival",
      startingLives: 3,
      lifeDamage: 1,
      wrongLifeLoss: 0,
    });
    await f.answer(f.a, true);
    await emit(f.late, "join", { name: "途中参加", code: f.code });
    assert.equal(f.player(f.late).lives, 3);
    assert.equal(f.player(f.b).lives, 2);
    assert.equal(
      (
        await emit(f.host, "settings", {
          settings: { rule: "seven-three", allowPlayerSound: false },
        })
      ).ok,
      false,
    );
    assert.equal(f.state().settings.rule, "survival");
    assert.equal(f.state().settings.allowPlayerSound, true);
    assert.equal(
      (await emit(f.host, "settings", { settings: { startingLives: 21 } })).ok,
      false,
    );
    await f.answer(f.b, false);
    assert.equal(f.player(f.b).lives, 2);
    await emit(f.host, "restartGame");
    assert.equal(
      (await emit(f.host, "settings", { settings: { rule: "seven-three" } }))
        .ok,
      true,
    );
  },
);
