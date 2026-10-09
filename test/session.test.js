import test from "node:test";
import assert from "node:assert/strict";
import { io as client } from "socket.io-client";
import { createApp } from "../server.js";

async function fixture(t, options = {}) {
  const app = createApp({ fetchVideoTitle: async () => "曲名", ...options });
  await new Promise((resolve) => app.http.listen(0, "127.0.0.1", resolve));
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await new Promise((resolve) => app.io.close(resolve));
  });
  return {
    ...app,
    connect: async (token) => {
      const s = client(`http://127.0.0.1:${app.http.address().port}`, {
        autoConnect: false,
        reconnection: false,
        auth: { sessionToken: token },
      });
      sockets.push(s);
      s.on("state", (state) => {
        s.roomState = state;
      });
      const session = new Promise((resolve) => s.once("session", resolve));
      s.connect();
      s.session = await session;
      return s;
    },
  };
}
const emit = (s, event, data = {}) =>
  new Promise((resolve, reject) =>
    s
      .timeout(2000)
      .emit(event, data, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
  );
function stateWhen(s, predicate) {
  if (s.roomState && predicate(s.roomState))
    return Promise.resolve(s.roomState);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off("state", listener);
      reject(Error("State not received"));
    }, 2000);
    function listener(state) {
      if (predicate(state)) {
        clearTimeout(timer);
        s.off("state", listener);
        resolve(state);
      }
    }
    s.on("state", listener);
  });
}

test(
  "anonymous host resumes its seat, questions and frozen round after disconnect and reload",
  { timeout: 10000 },
  async (t) => {
    const { connect } = await fixture(t);
    const host = await connect(),
      player = await connect();
    await emit(host, "create", { name: "運営", mode: "intro" });
    const before = await stateWhen(host, (s) => !!s.code),
      code = before.code;
    await emit(player, "join", { name: "回答者", code });
    await emit(host, "import", {
      questions: [
        { title: "曲", url: "https://youtu.be/jNQXAC9IVRw", start: 17 },
      ],
    });
    await emit(host, "settings", { settings: { allowPlayerMusic: true } });
    await emit(host, "start");
    const playing = await stateWhen(host, (s) => s.phase === "playing");
    const oldSocketId = host.id,
      token = host.session.token;
    host.disconnect();
    const paused = await stateWhen(
      player,
      (s) => s.players.find((p) => p.id === oldSocketId)?.online === false,
    );
    assert.equal(paused.hostId, oldSocketId);
    assert.equal(paused.phase, "paused");
    assert.equal(paused.roundId, playing.roundId);
    assert.ok(paused.elapsed >= 0);
    assert.equal(JSON.stringify(paused).includes(token), false);
    assert.equal((await emit(player, "start")).ok, false);
    const restored = await connect(token);
    const state = await stateWhen(restored, (s) => s.phase === "paused");
    assert.notEqual(restored.id, oldSocketId);
    assert.equal(restored.session.id, oldSocketId);
    assert.equal(restored.session.token, token);
    assert.equal(restored.session.roomCode, code);
    assert.equal(state.hostId, oldSocketId);
    assert.equal(state.players.length, 2);
    assert.equal(state.question.start, 17);
    assert.equal(state.questions.length, 1);
    assert.equal(state.settings.allowPlayerMusic, true);
    assert.equal(state.elapsed, paused.elapsed);
    assert.equal((await emit(restored, "start")).ok, true);
    assert.equal(
      (await stateWhen(restored, (s) => s.phase === "playing")).roundId,
      playing.roundId,
    );
  },
);

test(
  "player reconnect preserves score, life and buzz rank without adding another participant",
  { timeout: 10000 },
  async (t) => {
    const { connect } = await fixture(t);
    const host = await connect(),
      a = await connect(),
      b = await connect();
    await emit(host, "create", { name: "運営", mode: "button" });
    const { code } = await stateWhen(host, (s) => !!s.code);
    await emit(a, "join", { code, name: "あ" });
    await emit(b, "join", { code, name: "い" });
    await emit(host, "settings", { settings: { rule: "survival" } });
    await emit(host, "start");
    await emit(b, "buzz");
    const round = await stateWhen(host, (s) => s.buzzes.length === 1);
    await emit(host, "judge", {
      correct: true,
      id: b.id,
      roundId: round.roundId,
    });
    await emit(host, "score", { id: a.id, delta: 1 });
    await emit(a, "buzz");
    const originalId = a.id;
    a.disconnect();
    const offline = await stateWhen(
      host,
      (s) => !s.players.find((p) => p.id === originalId)?.online,
    );
    assert.equal(offline.players.find((p) => p.id === originalId).lives, 2);
    const back = await connect(a.session.token);
    const restored = await stateWhen(back, (s) => s.buzzes.length === 2);
    const me = restored.players.find((p) => p.id === originalId);
    assert.equal(restored.players.length, 3);
    assert.equal(me.score, 1);
    assert.equal(me.lives, 2);
    assert.equal(me.online, true);
    assert.equal(restored.buzzes[1].id, originalId);
    assert.equal((await emit(back, "buzz")).ok, true);
    assert.equal(host.roomState.buzzes.length, 2);
    assert.equal((await emit(back, "reset")).ok, false);
  },
);

test(
  "same name or guessed credentials cannot take an offline host seat; explicit exit transfers it",
  { timeout: 10000 },
  async (t) => {
    const { connect } = await fixture(t);
    const host = await connect(),
      player = await connect();
    await emit(host, "create", { name: "運営", mode: "normal" });
    const { code } = await stateWhen(host, (s) => !!s.code);
    await emit(player, "join", { code, name: "回答者" });
    host.disconnect();
    const impostor = await connect("x".repeat(43));
    assert.notEqual(impostor.session.id, host.session.id);
    assert.equal(impostor.session.roomCode, null);
    await emit(impostor, "join", { code, name: "運営" });
    assert.equal(
      (await emit(impostor, "import", { questions: [{ title: "秘密" }] })).ok,
      false,
    );
    const back = await connect(host.session.token);
    await stateWhen(back, (s) => s.hostId === host.session.id);
    await emit(back, "leave");
    const promoted = await stateWhen(
      player,
      (s) => s.hostId === player.session.id,
    );
    assert.equal(promoted.players.length, 2);
    back.disconnect();
    const afterExit = await connect(host.session.token);
    assert.equal(afterExit.session.roomCode, null);
    assert.equal((await emit(afterExit, "resume")).ok, false);
  },
);

test(
  "multiple tabs share one identity; only its last disconnect pauses the host",
  { timeout: 10000 },
  async (t) => {
    const { connect } = await fixture(t);
    const first = await connect(),
      guest = await connect();
    await emit(first, "create", { name: "運営", mode: "button" });
    const { code } = await stateWhen(first, (s) => !!s.code);
    await emit(guest, "join", { code, name: "回答者" });
    const second = await connect(first.session.token);
    await stateWhen(second, (s) => s.code === code);
    await emit(second, "start");
    first.disconnect();
    await emit(second, "resume");
    const stillPlaying = await stateWhen(guest, (s) => s.phase === "playing");
    assert.equal(stillPlaying.players.length, 2);
    assert.equal(
      stillPlaying.players.find((p) => p.id === first.session.id).online,
      true,
    );
    second.disconnect();
    await stateWhen(guest, (s) => s.phase === "paused");
    const back = await connect(first.session.token);
    await stateWhen(back, (s) => s.phase === "paused");
    await emit(back, "leave");
    assert.equal(
      (await stateWhen(guest, (s) => s.hostId === guest.session.id)).players
        .length,
      1,
    );
  },
);

test(
  "an all-offline room is retained briefly then expires without a phantom resume",
  { timeout: 10000 },
  async (t) => {
    const { connect, rooms } = await fixture(t, {
      roomIdleTtlMs: 25,
      cleanupIntervalMs: 5,
    });
    const host = await connect();
    await emit(host, "create", { name: "運営", mode: "button" });
    const { code } = await stateWhen(host, (s) => !!s.code);
    host.disconnect();
    assert.equal(rooms.has(code), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rooms.has(code), false);
    const back = await connect(host.session.token);
    assert.equal(back.session.roomCode, null);
    assert.equal((await emit(back, "start")).ok, false);
  },
);
