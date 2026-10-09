import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomBytes } from "node:crypto";
import { parse } from "csv-parse/sync";
import { fileURLToPath } from "node:url";
import { fetchYouTubeTitle, youtubeVideoId } from "./youtube.js";
import { evaluateGame, lifeLossForJudgment, ruleNames } from "./rules.js";
import { fetchYouTubePlaylist, youtubePlaylistId } from "./playlist.js";

export function questionsFromCsv(text) {
  const rows = parse(text.replace(/^\uFEFF/, ""), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  return rows
    .map((r) => ({
      title: r.title || r["問題"] || r.question || "",
      answer: r.answer || r["答え"] || "",
      url: r.url || r.youtube || r["URL"] || "",
      start: Math.max(0, Number(r.start || r["開始秒"]) || 0),
    }))
    .filter((q) => q.title || q.url)
    .slice(0, 500);
}
const defaultSettings = {
  allowPlayerSound: true,
  allowPlayerMusic: false,
  showTimer: true,
  showScores: true,
  recordAllBuzzes: true,
  correctPoints: 1,
  wrongPoints: 0,
  rule: "points",
  startingLives: 3,
  lifeDamage: 1,
  wrongLifeLoss: 1,
};
const soundTypes = new Set(["bell", "pop", "arcade", "none"]);

export function createApp({
  fetchVideoTitle = fetchYouTubeTitle,
  fetchPlaylist = fetchYouTubePlaylist,
  roomIdleTtlMs = 12 * 60 * 60 * 1000,
  cleanupIntervalMs = 60000,
} = {}) {
  const app = express();
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 512000 });
  const rooms = new Map();
  const sessions = new Map();
  const identityRoom = (id) => `anonymous:${id}`;
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.idleSince && now - room.idleSince >= roomIdleTtlMs)
        rooms.delete(code);
    }
    for (const [token, session] of sessions) {
      if (
        !session.socketIds.size &&
        !rooms.has(session.code) &&
        now - session.lastSeen > 7 * 24 * 60 * 60 * 1000
      )
        sessions.delete(token);
    }
  }, cleanupIntervalMs);
  cleanupTimer.unref();
  http.on("close", () => clearInterval(cleanupTimer));
  const titleCache = new Map();
  const metadataUpdates = new Map();
  function refreshGame(r, keepFinished = false) {
    const previous = r.game;
    const evaluated = evaluateGame(r);
    for (const p of r.players.values())
      Object.assign(p, evaluated.stats.get(p.id));
    r.game =
      keepFinished && previous?.status === "finished"
        ? previous
        : evaluated.game;
  }
  function queueMetadataUpdate(r) {
    if (metadataUpdates.has(r.code)) return;
    const timer = setTimeout(() => {
      metadataUpdates.delete(r.code);
      if (rooms.get(r.code) === r) broadcast(r);
    }, 100);
    timer.unref();
    metadataUpdates.set(r.code, timer);
  }
  async function lookupTitle(id) {
    let entry = titleCache.get(id);
    if (!entry || entry.expires < Date.now()) {
      const promise = Promise.resolve()
        .then(() => fetchVideoTitle(id))
        .then((title) => {
          if (typeof title !== "string" || !title.trim())
            throw Error("タイトルを取得できません");
          return title.trim().slice(0, 500);
        });
      entry = { promise, expires: Date.now() + 3600000 };
      titleCache.set(id, entry);
      if (titleCache.size > 1000)
        titleCache.delete(titleCache.keys().next().value);
      promise.catch(() => {
        if (titleCache.get(id) === entry) titleCache.delete(id);
      });
    }
    return entry.promise;
  }
  function enrichTitles(r, questions = r.questions) {
    if (r.mode !== "intro") return;
    const pending = questions.filter((q) => q.titleStatus !== "ready");
    for (const q of pending)
      q.titleStatus = youtubeVideoId(q.url) ? "loading" : "failed";
    let cursor = 0;
    async function worker() {
      while (
        cursor < pending.length &&
        rooms.get(r.code) === r &&
        r.questions === questions
      ) {
        const q = pending[cursor++],
          id = youtubeVideoId(q.url);
        if (!id) continue;
        try {
          const title = await lookupTitle(id);
          if (rooms.get(r.code) !== r || r.questions !== questions) return;
          q.answer = title;
          q.videoTitle = title;
          q.title ||= title;
          q.titleStatus = "ready";
        } catch {
          if (q.titleStatus !== "ready") q.titleStatus = "failed";
        }
        if (rooms.get(r.code) === r && r.questions === questions)
          queueMetadataUpdate(r);
      }
    }
    for (let i = 0; i < Math.min(3, pending.length); i++) void worker();
  }
  app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));
  app.get("/health", (_, res) => res.json({ ok: true }));
  function state(r, host = false) {
    const q = r.questions[r.index];
    return {
      serverNow: Date.now(),
      code: r.code,
      mode: r.mode,
      players: [...r.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        score: host || r.settings.showScores ? p.score : null,
        online: p.online,
        correct: host || r.settings.showScores ? p.correct : null,
        wrong: host || r.settings.showScores ? p.wrong : null,
        lives: host || r.settings.showScores ? p.lives : null,
        status: p.status,
      })),
      hostId: r.hostId,
      phase: r.phase,
      round: r.round,
      roundId: r.roundId,
      settings: r.settings,
      judgment: r.judgment,
      game: r.game,
      startedAt: r.startedAt,
      elapsed: r.elapsed,
      buzzes: r.buzzes,
      index: r.index,
      count: r.questions.length,
      revealed: r.revealed,
      question: q
        ? {
            title:
              r.mode === "intro" && !host && !r.revealed
                ? "曲名を当ててください"
                : q.title,
            url:
              r.mode === "intro" && (host || r.settings.allowPlayerMusic)
                ? q.url
                : "",
            start: q.start,
            answer: host || r.revealed ? q.answer : "",
            titleStatus: host ? q.titleStatus : undefined,
          }
        : null,
      questions: host ? r.questions : undefined,
    };
  }
  function broadcast(r) {
    r.idleSince = [...r.players.values()].some((p) => p.online)
      ? null
      : r.idleSince || Date.now();
    for (const p of r.players.values())
      io.to(identityRoom(p.id)).emit("state", state(r, p.id === r.hostId));
  }
  io.on("connection", (socket) => {
    const suppliedToken = socket.handshake.auth?.sessionToken;
    let session =
      typeof suppliedToken === "string" && /^[\w-]{43}$/.test(suppliedToken)
        ? sessions.get(suppliedToken)
        : undefined;
    if (!session) {
      session = {
        id: socket.id,
        token: randomBytes(32).toString("base64url"),
        socketIds: new Set(),
        code: undefined,
        lastSeen: Date.now(),
      };
      sessions.set(session.token, session);
    }
    const participantId = session.id;
    session.socketIds.add(socket.id);
    session.lastSeen = Date.now();
    socket.join(identityRoom(participantId));
    const get = () => rooms.get(session.code);
    const host = () => {
      const r = get();
      if (!r || r.hostId !== participantId)
        throw Error("司会者のみ操作できます");
      return r;
    };
    const reset = (r) => {
      r.phase = "ready";
      r.startedAt = null;
      r.elapsed = 0;
      r.buzzes = [];
      r.revealed = false;
      r.judgment = null;
      r.roundId = randomBytes(8).toString("hex");
    };
    const leave = () => {
      const r = get();
      if (!r) {
        session.code = undefined;
        return;
      }
      r.players.delete(participantId);
      for (const id of session.socketIds)
        io.sockets.sockets.get(id)?.leave(r.code);
      if (r.hostId === participantId)
        r.hostId =
          [...r.players.values()].find((p) => p.online)?.id ||
          [...r.players.keys()][0];
      if (!r.players.size) rooms.delete(r.code);
      else {
        refreshGame(r, true);
        if (r.game.status === "finished" && r.phase === "playing") {
          r.elapsed = Date.now() - r.startedAt;
          r.phase = "paused";
        }
        broadcast(r);
      }
      session.code = undefined;
      io.to(identityRoom(participantId)).emit("left", { code: r.code });
    };
    const on = (name, fn) =>
      socket.on(name, async (data = {}, ack = () => {}) => {
        try {
          const result = await fn(data);
          session.lastSeen = Date.now();
          ack({ ok: true, ...result });
        } catch (e) {
          ack({ ok: false, error: e.message });
        }
      });
    on("create", ({ name, mode }) => {
      if (!["button", "intro", "normal"].includes(mode))
        throw Error("モードが不正です");
      leave();
      let code;
      do {
        code = randomBytes(3).toString("hex").toUpperCase();
      } while (rooms.has(code));
      session.code = code;
      const r = {
        code,
        mode,
        hostId: participantId,
        players: new Map(),
        questions: [],
        index: 0,
        round: 1,
        settings: { ...defaultSettings },
        results: [],
        matchStarted: false,
        hadCompetition: false,
      };
      reset(r);
      r.players.set(participantId, {
        id: participantId,
        name: String(name || "司会").slice(0, 24),
        score: 0,
        online: true,
      });
      rooms.set(code, r);
      refreshGame(r);
      socket.join(code);
      broadcast(r);
    });
    on("join", ({ name, code: next }) => {
      const r = rooms.get(String(next).trim().toUpperCase());
      if (!r) throw Error("部屋が見つかりません");
      if (session.code === r.code && r.players.has(participantId)) {
        r.players.get(participantId).online = true;
        socket.join(r.code);
        broadcast(r);
        return;
      }
      if (r.players.size >= 30) throw Error("部屋は満員です");
      leave();
      session.code = r.code;
      r.players.set(participantId, {
        id: participantId,
        name: String(name || "ゲスト").slice(0, 24),
        score: 0,
        online: true,
        spectator: r.game.status === "finished",
      });
      for (const id of session.socketIds)
        io.sockets.sockets.get(id)?.join(r.code);
      if (
        [...r.players.values()].filter((p) => p.id !== r.hostId && !p.spectator)
          .length >= 2
      )
        r.hadCompetition = true;
      refreshGame(r, true);
      broadcast(r);
    });
    on("leave", leave);
    on("resume", () => {
      const r = get(),
        p = r?.players.get(participantId);
      if (!p)
        throw Error(
          "保存された部屋がありません。部屋を作り直すか参加してください",
        );
      p.online = true;
      socket.join(r.code);
      broadcast(r);
    });
    const previousRoom = get();
    const previousPlayer = previousRoom?.players.get(participantId);
    if (!previousPlayer) session.code = undefined;
    socket.emit("session", {
      id: participantId,
      token: session.token,
      roomCode: session.code || null,
    });
    if (previousPlayer) {
      previousPlayer.online = true;
      socket.join(previousRoom.code);
      broadcast(previousRoom);
    }
    on("import", ({ csv, questions }) => {
      const r = host();
      const qs = csv ? questionsFromCsv(String(csv)) : questions;
      if (!Array.isArray(qs) || !qs.length) throw Error("問題が見つかりません");
      if (qs.length > 500) throw Error("問題は500件までです");
      r.questions = qs.map((q) => ({
        title: String(q.title || "").slice(0, 500),
        answer: String(q.answer || "").slice(0, 500),
        url: String(q.url || "").slice(0, 500),
        start: Math.max(0, Number(q.start) || 0),
      }));
      r.index = 0;
      r.round = 1;
      reset(r);
      enrichTitles(r);
      broadcast(r);
    });
    on("sheet", async ({ url }) => {
      const r = host();
      let u;
      try {
        u = new URL(url);
      } catch {
        throw Error("URLが不正です");
      }
      if (u.hostname !== "docs.google.com" || u.protocol !== "https:")
        throw Error("公開GoogleスプレッドシートのURLを指定してください");
      const match = u.pathname.match(/^\/spreadsheets\/d\/(?:e\/)?([\w-]+)/);
      if (!match) throw Error("スプレッドシートのURLが不正です");
      const target = u.pathname.includes("/d/e/")
        ? `https://docs.google.com/spreadsheets/d/e/${match[1]}/pub?output=csv`
        : `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${encodeURIComponent(u.searchParams.get("gid") || "0")}`;
      const response = await fetch(target, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error("取得できません。シートを公開してください");
      const body = await response.text();
      if (host() !== r) throw Error("部屋が切り替わりました");
      if (body.length > 512000) throw Error("シートが大きすぎます");
      const qs = questionsFromCsv(body);
      if (!qs.length) throw Error("問題がありません");
      r.questions = qs;
      r.index = 0;
      r.round = 1;
      reset(r);
      enrichTitles(r);
      broadcast(r);
    });
    on("playlist", async ({ url }) => {
      const r = host();
      if (r.mode !== "intro") throw Error("イントロクイズのみ使用できます");
      if (r.phase === "playing")
        throw Error("クイズを止めてから取り込んでください");
      if (!youtubePlaylistId(url))
        throw Error("YouTubeのプレイリストURL（list=…）を入力してください");
      if (r.playlistLoading) throw Error("プレイリストを取り込み中です");
      r.playlistLoading = true;
      const roundId = r.roundId,
        questions = r.questions;
      try {
        const result = await fetchPlaylist(url);
        if (
          host() !== r ||
          r.roundId !== roundId ||
          r.questions !== questions ||
          r.phase === "playing"
        )
          throw Error(
            "部屋・問題が切り替わったため取り込みを中止しました。再試行してください",
          );
        if (
          !Array.isArray(result.questions) ||
          !result.questions.length ||
          result.questions.length > 500
        )
          throw Error("動画一覧を取得できません");
        r.questions = result.questions;
        r.index = 0;
        r.round = 1;
        reset(r);
        enrichTitles(r);
        broadcast(r);
        return {
          count: r.questions.length,
          skipped: result.skipped || 0,
          truncated: !!result.truncated,
        };
      } finally {
        r.playlistLoading = false;
      }
    });
    on("retryTitles", () => {
      const r = host();
      if (r.mode !== "intro") throw Error("イントロクイズのみ使用できます");
      enrichTitles(r);
      broadcast(r);
    });
    on("videoTitle", ({ videoId, title, roundId }) => {
      const r = host(),
        q = r.questions[r.index];
      if (
        r.mode !== "intro" ||
        !q ||
        roundId !== r.roundId ||
        videoId !== youtubeVideoId(q.url) ||
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 500
      )
        throw Error("現在の動画タイトルを指定してください");
      q.answer = q.videoTitle = title.trim();
      q.title ||= q.answer;
      q.titleStatus = "ready";
      broadcast(r);
    });
    on("start", () => {
      const r = host();
      if (r.game.status === "finished")
        throw Error("ゲームは終了しました。新しいゲームを始めてください");
      if (
        r.settings.rule === "survival" &&
        !r.matchStarted &&
        [...r.players.values()].filter((p) => p.status === "active").length < 2
      )
        throw Error("ライフバトルはプレイヤー2人以上で開始してください");
      if (r.mode !== "button" && !r.questions[r.index])
        throw Error("先に問題を取り込んでください");
      if (r.revealed || (r.phase !== "ready" && r.phase !== "paused"))
        throw Error("リセットしてから開始してください");
      r.startedAt = Date.now() - r.elapsed;
      r.phase = "playing";
      r.matchStarted = true;
      refreshGame(r);
      broadcast(r);
    });
    on("pause", () => {
      const r = host();
      if (r.phase === "playing") {
        r.elapsed = Date.now() - r.startedAt;
        r.phase = "paused";
        broadcast(r);
      }
    });
    on("buzz", ({ sound = "bell", roundId } = {}) => {
      const r = get();
      if (!r) throw Error("部屋に参加してください");
      if (r.hostId === participantId)
        throw Error("運営は早押しに参加できません");
      if (
        r.game.status === "finished" ||
        r.players.get(participantId)?.status !== "active"
      )
        throw Error("このゲームでは回答できません");
      if (roundId && roundId !== r.roundId)
        throw Error("ラウンドが切り替わりました");
      if (r.buzzes.some((b) => b.id === participantId)) return;
      if (!["playing", "buzzed"].includes(r.phase) || r.revealed)
        throw Error("まだ受付していません");
      if (r.phase === "buzzed" && !r.settings.recordAllBuzzes)
        throw Error("このラウンドは先着1人のみです");
      const ms = Date.now() - r.startedAt;
      r.buzzes.push({
        id: participantId,
        name: r.players.get(participantId).name,
        ms,
        sound:
          r.settings.allowPlayerSound && soundTypes.has(sound) ? sound : "none",
      });
      // Freeze the game clock on the first arrival, but keep collecting ranks.
      if (r.buzzes.length === 1) {
        r.elapsed = ms;
        r.phase = "buzzed";
      }
      broadcast(r);
    });
    on("reset", () => {
      const r = host();
      reset(r);
      broadcast(r);
    });
    on("next", () => {
      const r = host();
      if (r.game.status === "finished")
        throw Error("ゲームは終了しました。新しいゲームを始めてください");
      if (r.mode !== "button") {
        if (r.index + 1 >= r.questions.length) throw Error("最後の問題です");
        r.index++;
      }
      r.round++;
      reset(r);
      broadcast(r);
    });
    on("restartGame", () => {
      const r = host();
      r.results = [];
      r.matchStarted = false;
      r.hadCompetition = r.players.size >= 3;
      for (const p of r.players.values()) {
        p.score = 0;
        p.spectator = false;
      }
      r.index = 0;
      r.round = 1;
      reset(r);
      refreshGame(r);
      broadcast(r);
    });
    on("reveal", () => {
      const r = host();
      if (r.mode === "button" || !r.questions[r.index])
        throw Error("公開する答えがありません");
      if (r.phase === "playing") {
        r.elapsed = Date.now() - r.startedAt;
        r.phase = "paused";
      }
      r.revealed = true;
      broadcast(r);
    });
    on("settings", ({ settings }) => {
      const r = host();
      if (!settings || typeof settings !== "object" || Array.isArray(settings))
        throw Error("設定が不正です");
      for (const [key, value] of Object.entries(settings)) {
        if (!Object.hasOwn(defaultSettings, key)) throw Error("不明な設定です");
        if (typeof defaultSettings[key] === "boolean") {
          if (typeof value !== "boolean") throw Error("設定が不正です");
        } else if (key === "rule") {
          if (!Object.hasOwn(ruleNames, value)) throw Error("ルールが不正です");
        } else {
          const ranges = {
            correctPoints: [0, 100],
            wrongPoints: [-100, 0],
            startingLives: [1, 20],
            lifeDamage: [1, 20],
            wrongLifeLoss: [0, 20],
          };
          const [min, max] = ranges[key];
          if (!Number.isInteger(value) || value < min || value > max)
            throw Error("点数・ライフの設定範囲を確認してください");
        }
      }
      if (
        r.matchStarted &&
        ["rule", "startingLives", "lifeDamage", "wrongLifeLoss"].some(
          (key) =>
            Object.hasOwn(settings, key) && settings[key] !== r.settings[key],
        )
      )
        throw Error(
          "ルールを変更する前に「新しいゲーム」で成績をリセットしてください",
        );
      Object.assign(r.settings, settings);
      refreshGame(r, true);
      broadcast(r);
    });
    on("judge", ({ correct, id, roundId }) => {
      const r = host();
      const first = r.buzzes[0];
      if (
        typeof correct !== "boolean" ||
        !first ||
        first.id !== id ||
        roundId !== r.roundId
      )
        throw Error("現在の最初の回答者を判定してください");
      const p = r.players.get(first.id);
      if (!p || p.id === r.hostId) throw Error("回答者が部屋にいません");
      if (r.judgment?.correct === correct) return;
      const previousIndex = r.results.findIndex(
        (result) => result.roundId === r.roundId,
      );
      const remaining = r.results.filter(
        (result) => result.roundId !== r.roundId,
      );
      const before = evaluateGame({ ...r, results: remaining });
      if (r.judgment) p.score -= r.judgment.delta;
      const delta = correct ? r.settings.correctPoints : r.settings.wrongPoints;
      p.score += delta;
      r.judgment = { id: p.id, name: p.name, correct, delta };
      const result = {
        ...r.judgment,
        roundId: r.roundId,
        lifeLoss: lifeLossForJudgment(r, p.id, correct, before.stats),
      };
      if (previousIndex >= 0) r.results[previousIndex] = result;
      else r.results.push(result);
      refreshGame(r);
      broadcast(r);
    });
    on("score", ({ id, delta }) => {
      const r = host();
      const p = r.players.get(id);
      if (!p || id === r.hostId || ![1, -1].includes(delta))
        throw Error("採点が不正です");
      p.score += delta;
      broadcast(r);
    });
    socket.on("disconnect", () => {
      session.socketIds.delete(socket.id);
      session.lastSeen = Date.now();
      const r = get(),
        p = r?.players.get(participantId);
      if (!p || session.socketIds.size) return;
      p.online = false;
      if (r.hostId === participantId && r.phase === "playing") {
        r.elapsed = Date.now() - r.startedAt;
        r.phase = "paused";
      }
      broadcast(r);
    });
  });
  return { app, http, io, rooms };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { http } = createApp();
  http.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () =>
    console.log("Quiz server listening on port " + (process.env.PORT || 3000)),
  );
}
