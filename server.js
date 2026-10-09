import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomBytes } from "node:crypto";
import { parse } from "csv-parse/sync";
import { fileURLToPath } from "node:url";

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
export function createApp() {
  const app = express();
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 512000 });
  const rooms = new Map();
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
        score: p.score,
        online: p.online,
      })),
      hostId: r.hostId,
      phase: r.phase,
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
            url: r.mode === "intro" ? q.url : "",
            start: q.start,
            answer: host || r.revealed ? q.answer : "",
          }
        : null,
      questions: host ? r.questions : undefined,
    };
  }
  function broadcast(r) {
    for (const p of r.players.values())
      io.to(p.id).emit("state", state(r, p.id === r.hostId));
  }
  io.on("connection", (socket) => {
    let code;
    const get = () => rooms.get(code);
    const host = () => {
      const r = get();
      if (!r || r.hostId !== socket.id) throw Error("司会者のみ操作できます");
      return r;
    };
    const reset = (r) => {
      r.phase = "ready";
      r.startedAt = null;
      r.elapsed = 0;
      r.buzzes = [];
      r.revealed = false;
    };
    const leave = () => {
      const r = get();
      if (!r) return;
      r.players.delete(socket.id);
      socket.leave(code);
      if (r.hostId === socket.id) r.hostId = [...r.players.keys()][0];
      if (!r.players.size) rooms.delete(code);
      else broadcast(r);
      code = undefined;
    };
    const on = (name, fn) =>
      socket.on(name, async (data = {}, ack = () => {}) => {
        try {
          await fn(data);
          ack({ ok: true });
        } catch (e) {
          ack({ ok: false, error: e.message });
        }
      });
    on("create", ({ name, mode }) => {
      if (!["button", "intro", "normal"].includes(mode))
        throw Error("モードが不正です");
      leave();
      code = randomBytes(3).toString("hex").toUpperCase();
      const r = {
        code,
        mode,
        hostId: socket.id,
        players: new Map(),
        questions: [],
        index: 0,
      };
      reset(r);
      r.players.set(socket.id, {
        id: socket.id,
        name: String(name || "司会").slice(0, 24),
        score: 0,
        online: true,
      });
      rooms.set(code, r);
      socket.join(code);
      broadcast(r);
    });
    on("join", ({ name, code: next }) => {
      const r = rooms.get(String(next).trim().toUpperCase());
      if (!r) throw Error("部屋が見つかりません");
      if (r.players.size >= 30) throw Error("部屋は満員です");
      leave();
      code = r.code;
      r.players.set(socket.id, {
        id: socket.id,
        name: String(name || "ゲスト").slice(0, 24),
        score: 0,
        online: true,
      });
      socket.join(code);
      broadcast(r);
    });
    on("leave", leave);
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
      reset(r);
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
      if (body.length > 512000) throw Error("シートが大きすぎます");
      const qs = questionsFromCsv(body);
      if (!qs.length) throw Error("問題がありません");
      r.questions = qs;
      r.index = 0;
      reset(r);
      broadcast(r);
    });
    on("start", () => {
      const r = host();
      if (r.mode !== "button" && !r.questions[r.index])
        throw Error("先に問題を取り込んでください");
      if (r.phase !== "ready" && r.phase !== "paused")
        throw Error("リセットしてから開始してください");
      r.startedAt = Date.now() - r.elapsed;
      r.phase = "playing";
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
    on("buzz", () => {
      const r = get();
      if (!r || r.phase !== "playing") throw Error("まだ受付していません");
      if (r.buzzes.some((b) => b.id === socket.id)) return;
      const ms = Date.now() - r.startedAt;
      r.buzzes.push({ id: socket.id, name: r.players.get(socket.id).name, ms });
      r.elapsed = ms;
      r.phase = "buzzed";
      broadcast(r);
    });
    on("reset", () => {
      const r = host();
      reset(r);
      broadcast(r);
    });
    on("next", () => {
      const r = host();
      if (r.index + 1 >= r.questions.length) throw Error("最後の問題です");
      r.index++;
      reset(r);
      broadcast(r);
    });
    on("reveal", () => {
      const r = host();
      r.revealed = true;
      broadcast(r);
    });
    on("score", ({ id, delta }) => {
      const r = host();
      const p = r.players.get(id);
      if (!p || ![1, -1].includes(delta)) throw Error("採点が不正です");
      p.score += delta;
      broadcast(r);
    });
    socket.on("disconnect", leave);
  });
  return { app, http, io, rooms };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { http } = createApp();
  http.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () =>
    console.log("Quiz server listening on port " + (process.env.PORT || 3000)),
  );
}
