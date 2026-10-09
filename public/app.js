const $ = (id) => document.getElementById(id);
const socket = io();
let state,
  player,
  ytReady = false,
  pendingPlay = false,
  playlistLoading = false,
  lastVideo = "",
  toastTimeout,
  clockOffset = 0;
function toast(message) {
  $("toast").textContent = message;
  $("toast").style.display = "block";
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => ($("toast").style.display = "none"), 4500);
}
function send(event, data = {}) {
  return new Promise((resolve) =>
    socket.timeout(12000).emit(event, data, (error, result) => {
      if (error) {
        toast("通信がタイムアウトしました");
        resolve(false);
      } else if (!result.ok) {
        toast(result.error);
        resolve(false);
      } else resolve(true);
    }),
  );
}
const host = () => state?.hostId === socket.id;
function videoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
    if (
      ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(u.hostname)
    )
      return u.searchParams.get("v") || u.pathname.split("/").pop();
  } catch {}
  return /^[\w-]{11}$/.test(url) ? url : null;
}
function csvCell(v) {
  return '"' + String(v ?? "").replaceAll('"', '""') + '"';
}
function editorText(qs) {
  return (
    "title,answer,url,start\n" +
    qs
      .map((q) => [q.title, q.answer, q.url, q.start].map(csvCell).join(","))
      .join("\n")
  );
}
$("name").value = localStorage.getItem("quiz-name") || "";
function name() {
  const n = $("name").value.trim();
  if (!n) {
    toast("名前を入力してください");
    return null;
  }
  localStorage.setItem("quiz-name", n);
  return n;
}
$("createTab").onclick = () => {
  $("createForm").hidden = false;
  $("joinForm").hidden = true;
  $("createTab").classList.add("selected");
  $("joinTab").classList.remove("selected");
};
$("joinTab").onclick = () => {
  $("createForm").hidden = true;
  $("joinForm").hidden = false;
  $("joinTab").classList.add("selected");
  $("createTab").classList.remove("selected");
};
const invite = new URLSearchParams(location.search).get("room");
if (invite) {
  $("joinTab").click();
  $("code").value = invite;
}
$("create").onclick = () => {
  const n = name();
  if (n) send("create", { name: n, mode: $("mode").value });
};
$("join").onclick = () => {
  const n = name();
  if (n) send("join", { name: n, code: $("code").value });
};
$("leave").onclick = async () => {
  if (await send("leave")) {
    state = null;
    player?.stopVideo();
    $("lobby").hidden = false;
    $("room").hidden = true;
    history.replaceState(null, "", "/");
  }
};
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(
      location.origin + "/?room=" + state.code,
    );
    toast("招待リンクをコピーしました");
  } catch {
    toast("部屋コード：" + state.code);
  }
};
$("buzz").onclick = () => send("buzz");
document.addEventListener("keydown", (e) => {
  if (
    e.code === "Space" &&
    !e.repeat &&
    !["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(e.target.tagName) &&
    state?.phase === "playing"
  ) {
    e.preventDefault();
    send("buzz");
  }
});
for (const action of ["pause", "reset", "reveal", "next"])
  $(action).onclick = () => {
    pendingPlay = false;
    send(action);
  };
$("start").onclick = () => {
  if (state.mode !== "intro") {
    send("start");
    return;
  }
  const id = videoId(state.question?.url || "");
  if (!id) {
    toast("この問題に有効なYouTube URLを設定してください");
    return;
  }
  if (!player || !ytReady) {
    toast(
      "YouTubeプレイヤーを読み込んでいます。少し待ってから再度開始してください",
    );
    return;
  }
  pendingPlay = true;
  if (state.phase === "ready" || lastVideo !== id) {
    lastVideo = id;
    player.loadVideoById({
      videoId: id,
      startSeconds: state.question.start || 0,
    });
  } else player.playVideo();
};
$("csv").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 500000) {
    toast("CSVは500KB以下にしてください");
    return;
  }
  await send("import", { csv: await file.text() });
  e.target.value = "";
};
$("sheet").onclick = () => send("sheet", { url: $("sheetUrl").value.trim() });
$("saveQuestions").onclick = () => send("import", { csv: $("editor").value });
$("sample").onclick = () => {
  if (state.mode === "intro")
    send("import", {
      questions: [
        {
          title: "サンプル曲（答えを編集してください）",
          answer: "編集して設定",
          url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
          start: 0,
        },
      ],
    });
  else
    fetch("/sample.csv")
      .then((r) => r.text())
      .then((csv) => send("import", { csv }));
};
$("playlist").onclick = () => {
  let list;
  try {
    list = new URL($("playlistUrl").value).searchParams.get("list");
  } catch {}
  if (!list || !/^[-\w]+$/.test(list)) {
    toast("プレイリストURLを入力してください");
    return;
  }
  if (!player || !ytReady) {
    toast("YouTubeの読み込み完了後に再試行してください");
    return;
  }
  if (state.phase === "playing") {
    toast("クイズを止めてから取り込んでください");
    return;
  }
  playlistLoading = true;
  pendingPlay = false;
  player.cuePlaylist({ listType: "playlist", list, index: 0 });
  let attempts = 0;
  const poll = setInterval(async () => {
    const ids = player.getPlaylist();
    if (ids?.length) {
      clearInterval(poll);
      playlistLoading = false;
      await send("import", {
        questions: ids
          .slice(0, 500)
          .map((id, i) => ({
            title: `曲 ${i + 1}`,
            answer: "",
            url: `https://www.youtube.com/watch?v=${id}`,
            start: 0,
          })),
      });
      toast(`${ids.length}曲を取り込みました。答えを編集してください`);
    } else if (++attempts >= 20) {
      clearInterval(poll);
      playlistLoading = false;
      toast("リストを取得できません。公開設定を確認するかCSVを使ってください");
    }
  }, 500);
};
socket.on("connect", () => {
  $("connection").textContent = "● オンライン";
});
socket.on("disconnect", () => {
  $("connection").textContent = "接続が切れました";
  pendingPlay = false;
  player?.pauseVideo();
  toast("接続が切れました。再接続後、部屋に入り直してください");
});
socket.on("state", (s) => {
  const prev = state;
  state = s;
  clockOffset = s.serverNow - Date.now();
  const isHost = host();
  $("lobby").hidden = true;
  $("room").hidden = false;
  history.replaceState(null, "", "/?room=" + s.code);
  $("roomCode").textContent = s.code;
  $("modeLabel").textContent = {
    intro: "INTRO QUIZ",
    button: "BUZZER ONLY",
    normal: "NORMAL QUIZ",
  }[s.mode];
  $("phase").textContent = {
    ready: "準備中",
    playing: "受付中",
    paused: "一時停止",
    buzzed: "回答待ち",
  }[s.phase];
  $("progress").textContent =
    s.mode === "button"
      ? "早押しボタン"
      : `${s.count ? s.index + 1 : 0} / ${s.count} 問`;
  $("question").textContent =
    s.mode === "button"
      ? "わかったら、押そう。"
      : s.question?.title || "問題を取り込んでください";
  $("answer").textContent =
    s.question?.answer && (s.revealed || isHost)
      ? `答え：${s.question.answer}`
      : "";
  $("buzz").disabled = s.phase !== "playing";
  $("winner").textContent = s.buzzes[0]
    ? `⚡ ${s.buzzes[0].name} さんが早押し！ (${(s.buzzes[0].ms / 1000).toFixed(3)}秒)`
    : "";
  $("hostControls").hidden = !isHost;
  $("imports").hidden = !isHost || s.mode === "button";
  $("playlistSection").hidden = s.mode !== "intro";
  $("youtube").hidden = s.mode !== "intro";
  $("mediaNote").hidden = s.mode !== "intro";
  $("start").disabled = !["ready", "paused"].includes(s.phase);
  $("pause").disabled = s.phase !== "playing";
  $("next").disabled = s.index + 1 >= s.count;
  $("reveal").hidden = s.mode === "button";
  $("next").hidden = s.mode === "button";
  $("playerCount").textContent = `(${s.players.length})`;
  $("players").replaceChildren();
  for (const p of s.players) {
    const row = document.createElement("div");
    row.className = "person";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = p.name.slice(0, 1);
    const label = document.createElement("div");
    label.className = "name";
    label.textContent = p.name;
    const role = document.createElement("small");
    role.textContent =
      p.id === s.hostId ? "司会者" : p.id === socket.id ? "あなた" : "参加者";
    label.append(role);
    const score = document.createElement("strong");
    score.textContent = p.score;
    row.append(avatar, label, score);
    if (isHost)
      for (const delta of [-1, 1]) {
        const b = document.createElement("button");
        b.textContent = delta === 1 ? "＋" : "−";
        b.onclick = () => send("score", { id: p.id, delta });
        row.append(b);
      }
    $("players").append(row);
  }
  if (
    isHost &&
    s.questions &&
    (!prev || JSON.stringify(prev.questions) !== JSON.stringify(s.questions))
  )
    $("editor").value = editorText(s.questions);
  if (isHost && s.mode === "intro") ensureYouTube();
  if (player && s.phase !== "playing" && !pendingPlay) player.pauseVideo();
  if (
    player &&
    prev &&
    (prev.index !== s.index || (s.phase === "ready" && prev.phase !== "ready"))
  ) {
    pendingPlay = false;
    player.stopVideo();
    lastVideo = "";
  }
});
function ensureYouTube() {
  if (player) return;
  if (window.YT?.Player) {
    player = new YT.Player("player", {
      height: "180",
      width: "320",
      playerVars: { playsinline: 1 },
      events: {
        onReady: () => {
          ytReady = true;
        },
        onStateChange: async (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            if (pendingPlay && host()) {
              pendingPlay = false;
              if (!(await send("start"))) player.pauseVideo();
            } else if (state?.phase !== "playing" && !playlistLoading)
              player.pauseVideo();
          }
          if (
            [YT.PlayerState.ENDED, YT.PlayerState.PAUSED].includes(e.data) &&
            state?.phase === "playing" &&
            host()
          )
            send("pause");
        },
        onError: () => {
          pendingPlay = false;
          toast(
            "YouTube動画を再生できません。埋め込み許可やURLを確認してください",
          );
          if (state?.phase === "playing") send("pause");
        },
      },
    });
  } else if (!document.getElementById("yt-api")) {
    const script = document.createElement("script");
    script.id = "yt-api";
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () =>
      toast("YouTubeに接続できません。通信設定を確認してください");
    document.head.append(script);
  }
}
window.onYouTubeIframeAPIReady = ensureYouTube;
function tick() {
  if (state) {
    const ms =
      state.phase === "playing"
        ? Math.max(0, Date.now() + clockOffset - state.startedAt)
        : state.elapsed || 0;
    $("timer").firstChild.textContent = (ms / 1000).toFixed(3);
  }
  requestAnimationFrame(tick);
}
tick();
