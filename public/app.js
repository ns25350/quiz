import { createBuzzerCustomization } from "./buzzer.js";
import { createPlayerIntroAudio } from "./intro-audio.js";
import {
  createMusicVisualizer,
  renderGameRule,
  ruleDescription,
  ruleProgressNode,
  statusText,
} from "./game-ui.js";

const $ = (id) => document.getElementById(id);
const socket = io();
let state,
  player,
  ytReady = false,
  pendingPlay = false,
  pendingBuzz = false,
  pendingJudgment = false,
  playlistLoading = false,
  lastVideo = "",
  toastTimeout,
  clockOffset = 0;
let editorDirty = false,
  cuedTitleRound = "",
  reportedTitle = "";
const phaseNames = {
  ready: "スタンバイ",
  playing: "早押し受付中",
  paused: "一時停止",
  buzzed: "回答待ち · 順位受付中",
};
const modeNames = {
  intro: "イントロクイズ",
  button: "早押しボタンのみ",
  normal: "ノーマルクイズ",
};
const host = () => state?.hostId === socket.id;
const contestants = () => state.players.filter((p) => p.id !== state.hostId);
const myBuzz = () => state?.buzzes.find((b) => b.id === socket.id);
const inSession = () =>
  socket.connected && state?.players.some((p) => p.id === socket.id);
const canBuzz = () =>
  inSession() &&
  !host() &&
  state.game.status !== "finished" &&
  state.players.find((p) => p.id === socket.id)?.status === "active" &&
  !state.revealed &&
  (state.phase === "playing" ||
    (state.phase === "buzzed" && state.settings.recordAllBuzzes)) &&
  !document.querySelector("dialog[open]") &&
  !myBuzz() &&
  !pendingBuzz;
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
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function setPhase(id) {
  $(id).textContent =
    state.game.status === "finished"
      ? "ゲーム終了"
      : state.revealed
        ? "答えを公開中"
        : state.phase === "buzzed" && !state.settings.recordAllBuzzes
          ? "回答待ち"
          : phaseNames[state.phase];
  $(id).dataset.phase = state.phase;
}
function roundLabel() {
  return state.mode === "button"
    ? `ROUND ${String(state.round).padStart(2, "0")}`
    : `QUESTION ${state.count ? state.index + 1 : 0} / ${state.count}`;
}
function updateConnection() {
  document.body.dataset.connected = String(socket.connected);
  document
    .querySelectorAll(".connection")
    .forEach(
      (node) =>
        (node.textContent = socket.connected ? "オンライン" : "オフライン"),
    );
}
function showLobby(code = "") {
  state = null;
  pendingPlay = pendingBuzz = false;
  player?.stopVideo();
  lastVideo = "";
  cuedTitleRound = reportedTitle = "";
  playerIntroAudio.reset();
  document.body.dataset.screen = "lobby";
  $("lobby").hidden = false;
  $("room").hidden = true;
  history.replaceState(null, "", code ? "/?room=" + code : "/");
  if (code) {
    $("joinTab").click();
    $("code").value = code;
  }
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
  $("createTab").setAttribute("aria-pressed", "true");
  $("joinTab").setAttribute("aria-pressed", "false");
};
$("joinTab").onclick = () => {
  $("createForm").hidden = true;
  $("joinForm").hidden = false;
  $("joinTab").classList.add("selected");
  $("createTab").classList.remove("selected");
  $("joinTab").setAttribute("aria-pressed", "true");
  $("createTab").setAttribute("aria-pressed", "false");
};
const invite = new URLSearchParams(location.search).get("room");
if (invite) {
  $("joinTab").click();
  $("code").value = invite;
}
$("create").onclick = () => {
  const n = name();
  if (n) {
    customization.unlockAudio();
    send("create", { name: n, mode: $("mode").value });
  }
};
$("join").onclick = () => {
  const n = name();
  if (n) {
    customization.unlockAudio();
    send("join", { name: n, code: $("code").value });
  }
};
for (const id of ["hostLeave", "playerLeave"])
  $(id).onclick = async () => {
    if (await send("leave")) showLobby();
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
$("openImports").onclick = () => {
  $("imports").open = true;
  $("imports").scrollIntoView({ block: "start", behavior: "smooth" });
};
async function buzz() {
  if (!canBuzz()) return;
  customization.unlockAudio();
  pendingBuzz = true;
  renderBuzzer();
  await send("buzz", {
    roundId: state.roundId,
    sound: customization.preferences.sound,
  });
  pendingBuzz = false;
  if (state && !host()) renderBuzzer();
}
$("buzz").addEventListener("pointerdown", (e) => {
  if (e.button === 0 && canBuzz()) {
    e.preventDefault();
    buzz();
  }
});
$("buzz").addEventListener("click", (e) => {
  if (e.detail === 0) buzz();
});
document.addEventListener("keydown", (e) => {
  if (
    e.code === "Space" &&
    !e.repeat &&
    !["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY"].includes(
      e.target.tagName,
    ) &&
    canBuzz()
  ) {
    e.preventDefault();
    buzz();
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
    toast("YouTubeプレイヤーの読み込み完了後に開始してください");
    return;
  }
  pendingPlay = true;
  renderHostControls();
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
  await importQuestions({ csv: await file.text() });
  e.target.value = "";
};
async function importQuestions(data, event = "import") {
  const wasDirty = editorDirty;
  editorDirty = false;
  const ok = await send(event, data);
  if (!ok) editorDirty = wasDirty;
  return ok;
}
$("editor").addEventListener("input", () => {
  editorDirty = true;
});
$("sheet").onclick = () =>
  importQuestions({ url: $("sheetUrl").value.trim() }, "sheet");
$("saveQuestions").onclick = () => importQuestions({ csv: $("editor").value });
$("retryTitles").onclick = () => send("retryTitles");
$("restartGame").onclick = () => {
  if (
    confirm(
      "全員の得点・正解数・不正解数・ライフをリセットし、最初の問題に戻します。新しいゲームを始めますか？",
    )
  )
    send("restartGame");
};
$("sample").onclick = () => {
  if (state.mode === "intro")
    importQuestions({
      questions: [
        {
          title: "サンプル曲（答えを編集してください）",
          answer: "",
          url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
          start: 0,
        },
      ],
    });
  else
    fetch("/sample.csv")
      .then((r) => r.text())
      .then((csv) => importQuestions({ csv }));
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
      await importQuestions({
        questions: ids.slice(0, 500).map((id, i) => ({
          title: `曲 ${i + 1}`,
          answer: "",
          url: `https://www.youtube.com/watch?v=${id}`,
          start: 0,
        })),
      });
      toast(
        `${ids.length}曲を取り込みました。答えを動画タイトルから自動設定します`,
      );
    } else if (++attempts >= 20) {
      clearInterval(poll);
      playlistLoading = false;
      toast("リストを取得できません。公開設定を確認するかCSVを使ってください");
    }
  }, 500);
};
const customization = createBuzzerCustomization({
  getRoom: () => state,
  toast,
});
const playerIntroAudio = createPlayerIntroAudio({
  getRoom: () => state,
  isPlayer: () => inSession() && !host(),
  getClockOffset: () => clockOffset,
  videoId,
  requestApi: requestYouTubeApi,
});
const musicVisualizer = createMusicVisualizer({
  getRoom: () => state,
  inSession,
  getPlaybackState: playerIntroAudio.getPlaybackState,
});
window.addEventListener("buzzer-preferences", () => {
  if (state && !host()) renderBuzzer();
});
for (const button of document.querySelectorAll("[data-close]"))
  button.onclick = () => $(button.dataset.close).close();
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (e) => {
    const rect = dialog.getBoundingClientRect();
    if (
      e.target === dialog &&
      (e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom)
    )
      dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (state && !host()) renderBuzzer();
  });
}
const settingNames = [
  "allowPlayerSound",
  "allowPlayerMusic",
  "recordAllBuzzes",
  "showTimer",
  "showScores",
  "correctPoints",
  "wrongPoints",
  "rule",
  "startingLives",
  "lifeDamage",
  "wrongLifeLoss",
];
function renderRuleSettings() {
  const settings = {
    ...state.settings,
    rule: $("rule").value,
    startingLives: Number($("startingLives").value),
    lifeDamage: Number($("lifeDamage").value),
    wrongLifeLoss: Number($("wrongLifeLoss").value),
  };
  $("ruleSettingDescription").textContent = ruleDescription(settings);
  $("lifeSettings").hidden = settings.rule !== "survival";
}
for (const key of ["rule", "startingLives", "lifeDamage", "wrongLifeLoss"])
  $(key).addEventListener("input", renderRuleSettings);
$("openRoomSettings").onclick = () => {
  for (const key of settingNames) {
    if ($(key).type === "checkbox") $(key).checked = state.settings[key];
    else $(key).value = state.settings[key];
  }
  const locked = state.game.status !== "waiting";
  for (const key of ["rule", "startingLives", "lifeDamage", "wrongLifeLoss"])
    $(key).disabled = locked;
  $("ruleSettingsLocked").hidden = !locked;
  renderRuleSettings();
  $("allowPlayerMusic").disabled = state.mode !== "intro";
  $("playerMusicSettingNote").textContent =
    state.mode === "intro"
      ? "各プレイヤーが音声を有効にすると、再生・停止が連動します"
      : "イントロクイズで使用できます";
  $("roomSettingsDialog").showModal();
};
$("roomSettingsForm").onsubmit = async (e) => {
  e.preventDefault();
  const settings = Object.fromEntries(
    settingNames.map((key) => [
      key,
      $(key).type === "checkbox"
        ? $(key).checked
        : $(key).type === "number"
          ? Number($(key).value)
          : $(key).value,
    ]),
  );
  if (await send("settings", { settings })) {
    $("roomSettingsDialog").close();
    toast("ゲームの設定を反映しました");
  }
};
function signed(delta) {
  return delta > 0 ? `+${delta}` : String(delta);
}
function renderJudgment() {
  const first = state.buzzes[0];
  const eligible =
    inSession() &&
    !pendingJudgment &&
    first &&
    contestants().some((p) => p.id === first.id);
  $("judgeCorrect").disabled = $("judgeWrong").disabled = !eligible;
  $("judgeCorrect").setAttribute(
    "aria-pressed",
    String(state.judgment?.correct === true),
  );
  $("judgeWrong").setAttribute(
    "aria-pressed",
    String(state.judgment?.correct === false),
  );
  $("correctDelta").textContent =
    state.settings.rule === "seven-three"
      ? "○ +1"
      : state.settings.rule === "survival"
        ? `他の人 −${state.settings.lifeDamage} LIFE`
        : `${signed(state.settings.correctPoints)} PT`;
  $("wrongDelta").textContent =
    state.settings.rule === "seven-three"
      ? "× +1"
      : state.settings.rule === "survival"
        ? `本人 −${state.settings.wrongLifeLoss} LIFE`
        : `${signed(state.settings.wrongPoints)} PT`;
  $("hostWinnerTile").dataset.judgment = state.judgment
    ? state.judgment.correct
      ? "correct"
      : "wrong"
    : "";
  $("judgmentStatus").textContent = state.judgment
    ? `${state.judgment.correct ? "正解" : "不正解"} · ${signed(state.judgment.delta)}点 / 判定を押し直すと修正できます。`
    : first
      ? "この回答者を判定してください。"
      : "最初の回答者をここから判定できます。";
}
for (const [id, correct] of [
  ["judgeCorrect", true],
  ["judgeWrong", false],
])
  $(id).onclick = async () => {
    if (!state.buzzes[0] || pendingJudgment) return;
    pendingJudgment = true;
    renderJudgment();
    await send("judge", {
      correct,
      id: state.buzzes[0].id,
      roundId: state.roundId,
    });
    pendingJudgment = false;
    if (state && host()) renderJudgment();
  };
function renderHostControls() {
  const connected = inSession();
  $("start").disabled =
    !connected ||
    pendingPlay ||
    state.game.status === "finished" ||
    state.revealed ||
    !["ready", "paused"].includes(state.phase) ||
    (state.mode !== "button" && !state.count);
  $("startLabel").textContent = pendingPlay
    ? "再生待ち"
    : state.phase === "paused"
      ? "再開"
      : "スタート";
  $("startHint").textContent = pendingPlay
    ? "再生が始まると計時開始"
    : state.mode === "intro"
      ? "再生と同時にタイマー開始"
      : "早押し受付を開始";
  $("next").disabled =
    !connected ||
    state.game.status === "finished" ||
    (state.mode !== "button" && state.index + 1 >= state.count);
  $("nextHint").textContent =
    state.mode === "button" ? "次のラウンドを準備" : "次の問題を準備";
  $("pause").disabled = !connected || state.phase !== "playing";
  $("reset").disabled = !connected;
  $("reveal").hidden = state.mode === "button";
  $("reveal").disabled = !connected || !state.question || state.revealed;
  $("openRoomSettings").disabled = !connected;
  $("restartGame").disabled = !connected;
  renderJudgment();
}
function renderHost(s, prev) {
  $("roomCode").textContent = s.code;
  $("modeLabel").textContent = modeNames[s.mode];
  $("hostProgress").textContent = roundLabel();
  $("hostPlayerCount").textContent = contestants().length;
  setPhase("hostPhase");
  $("hostQuestion").textContent =
    s.mode === "button"
      ? "あなたの合図で、早押し開始。"
      : s.question?.title || "まずは問題をセットしよう。";
  $("hostAnswer").hidden = !s.question?.answer;
  $("hostAnswer").textContent = `答え：${s.question?.answer || ""}`;
  $("hostQuestionHint").textContent =
    s.mode === "button"
      ? "口頭や外部の音源で出題できます。"
      : s.revealed
        ? "プレイヤーに答えを公開中です。"
        : s.mode === "intro" && s.question?.titleStatus === "loading"
          ? "動画タイトルから答えを取得しています。"
          : s.mode === "intro" && s.question?.titleStatus === "failed"
            ? "動画タイトルの取得に失敗しました。再試行するか答えを手動で入力してください。"
            : "問題と答えは運営用。準備ができたらスタート。";
  const first = s.buzzes[0];
  $("hostWinnerTile").dataset.active = String(!!first);
  renderJudgment();
  $("hostWinner").textContent = first
    ? first.name
    : "最初の早押しを待っています";
  $("hostWinnerTime").textContent = first
    ? `1番 · ${(first.ms / 1000).toFixed(3)} 秒`
    : "—";
  $("queueCount").textContent = `${s.buzzes.length} 人`;
  $("queueEmpty").hidden = !!s.buzzes.length;
  $("hostQueue").replaceChildren(
    ...s.buzzes.map((b, i) => {
      const row = element("li", "queue-row");
      row.dataset.playerId = b.id;
      row.append(
        element("span", "queue-order", i + 1),
        element("span", "queue-name", b.name),
        element("span", "queue-time", `${(b.ms / 1000).toFixed(3)} s`),
      );
      return row;
    }),
  );
  const focused = document.activeElement?.dataset.scoreId
    ? {
        id: document.activeElement.dataset.scoreId,
        delta: document.activeElement.dataset.delta,
      }
    : null;
  $("hostScores").replaceChildren(
    ...contestants().map((p) => {
      const rank = s.buzzes.findIndex((b) => b.id === p.id) + 1;
      const card = element("div", "score-card");
      card.dataset.playerId = p.id;
      card.dataset.first = String(rank === 1);
      card.dataset.rule = s.settings.rule;
      card.dataset.status = p.status;
      const top = element("div", "score-card-top");
      top.append(
        element("span", "score-card-name", p.name),
        element(
          "span",
          "score-rank",
          statusText(p, s.settings) || (rank ? `${rank}番` : "待機"),
        ),
      );
      if (s.settings.rule !== "points")
        top.append(ruleProgressNode(p, s.settings));
      const bottom = element("div", "score-card-bottom");
      const score = element("div", "score-value", p.score);
      score.append(element("small", "", "PT"));
      const controls = [];
      for (const delta of [-1, 1]) {
        const button = element("button", "", delta === 1 ? "＋" : "−");
        button.dataset.scoreId = p.id;
        button.dataset.delta = delta;
        button.setAttribute(
          "aria-label",
          `${p.name}の得点を${delta === 1 ? "1点増やす" : "1点減らす"}`,
        );
        button.disabled = !inSession();
        button.onclick = () => send("score", { id: p.id, delta });
        controls.push(button);
      }
      bottom.append(controls[0], score, controls[1]);
      card.append(top, bottom);
      return card;
    }),
  );
  if (focused)
    document
      .querySelector(
        `[data-score-id="${CSS.escape(focused.id)}"][data-delta="${focused.delta}"]`,
      )
      ?.focus({ preventScroll: true });
  $("hostScoresEmpty").hidden = contestants().length > 0;
  $("imports").hidden = s.mode === "button";
  $("openImports").hidden = s.mode === "button";
  $("playlistSection").hidden = s.mode !== "intro";
  $("youtube").hidden = s.mode !== "intro";
  if (
    s.questions &&
    !editorDirty &&
    (!prev || JSON.stringify(prev.questions) !== JSON.stringify(s.questions))
  )
    $("editor").value = editorText(s.questions);
  $("titleImportStatus").hidden = s.mode !== "intro" || !s.count;
  if (s.mode === "intro" && s.questions) {
    const ready = s.questions.filter((q) => q.titleStatus === "ready").length;
    const failed = s.questions.filter((q) => q.titleStatus === "failed").length;
    const loading = s.count - ready - failed;
    $("titleImportMessage").textContent =
      `動画タイトルから答えを設定：${ready} / ${s.count}曲${loading ? ` · ${loading}曲取得中` : ""}${failed ? ` · ${failed}曲取得失敗（手動入力もできます）` : ""}`;
    $("retryTitles").hidden = !failed || loading > 0;
  }
  renderHostControls();
  if (s.mode === "intro") ensureYouTube();
}
function renderBuzzer() {
  const mine = myBuzz();
  const rank = state.buzzes.findIndex((b) => b.id === socket.id) + 1;
  const me = state.players.find((p) => p.id === socket.id);
  const inactive = me?.status !== "active" || state.game.status === "finished";
  $("buzz").disabled = !canBuzz();
  $("buzzerDock").dataset.buzzed = String(!!mine);
  $("buzzLabel").textContent = inactive
    ? statusText(me, state.settings) || "ゲーム終了"
    : mine
      ? "押下済み！"
      : pendingBuzz
        ? "送信中…"
        : canBuzz()
          ? customization.preferences.text
          : state.revealed
            ? "答え公開中"
            : state.phase === "paused"
              ? "一時停止"
              : state.phase === "buzzed"
                ? "受付終了"
                : "スタンバイ";
  $("myRank").textContent = mine ? `あなたは ${rank} 番` : "YOUR BUZZER";
  $("buzzStatus").textContent = !inSession()
    ? "接続待ち"
    : inactive
      ? state.game.status === "finished"
        ? "ゲーム終了 · 新しいゲームを待っています"
        : "観戦中 · 次のゲームを待っています"
      : mine
        ? `${(mine.ms / 1000).toFixed(3)} 秒で押しました`
        : state.revealed
          ? "次の問題を待っています"
          : state.phase === "buzzed"
            ? state.settings.recordAllBuzzes
              ? "まだ押せます · 順番を記録"
              : "今回は先着1人のみ"
            : state.phase === "playing"
              ? "わかったら、押そう！"
              : "運営の開始を待っています";
}
function renderPlayer(s) {
  const me = s.players.find((p) => p.id === socket.id);
  $("myName").textContent = me?.name || "プレイヤー";
  $("myScore").textContent = me?.score ?? "—";
  $("timerDisplay").hidden = !s.settings.showTimer;
  $("timerHiddenNote").hidden = s.settings.showTimer;
  $("playerProgress").textContent = roundLabel();
  $("playerRoomCode").textContent = `ROOM ${s.code}`;
  setPhase("playerPhase");
  $("playerQuestion").textContent =
    s.mode === "button"
      ? s.phase === "ready"
        ? "運営の合図を待とう。"
        : "わかったら、誰よりも早く。"
      : s.question?.title || "問題の準備を待っています";
  $("playerAnswer").hidden = !s.revealed || !s.question?.answer;
  $("playerAnswer").textContent = `答え：${s.question?.answer || ""}`;
  $("playerWinner").hidden = !s.buzzes.length;
  $("playerWinner").dataset.judgment = s.judgment
    ? s.judgment.correct
      ? "correct"
      : "wrong"
    : "";
  $("playerWinner").textContent = s.buzzes[0]
    ? `${s.judgment ? (s.judgment.correct ? "○ 正解" : "× 不正解") : "⚡ 1番"} ${s.buzzes[0].name} · ${(s.buzzes[0].ms / 1000).toFixed(3)} 秒`
    : "";
  $("playerCount").textContent = `${contestants().length} PLAYERS`;
  $("podiums").replaceChildren(
    ...contestants().map((p) => {
      const index = s.buzzes.findIndex((b) => b.id === p.id);
      const b = s.buzzes[index];
      const card = element("article", "podium");
      card.dataset.playerId = p.id;
      card.dataset.self = String(p.id === socket.id);
      card.dataset.buzzed = String(!!b);
      card.dataset.first = String(index === 0);
      card.dataset.status = p.status;
      const top = element("div", "podium-top");
      card.dataset.rule = s.settings.rule;
      top.append(
        element(
          "span",
          "podium-order",
          statusText(p, s.settings) || (b ? `${index + 1} 番` : "待機中"),
        ),
      );
      if (p.id === socket.id)
        top.append(element("span", "self-badge", "あなた"));
      const body = element("div", "podium-body");
      const score = element("div", "podium-score", p.score ?? "—");
      score.append(element("small", "", "PT"));
      body.append(
        element("div", "podium-avatar", Array.from(p.name)[0]),
        element("div", "podium-name", p.name),
        score,
        element(
          "div",
          "podium-time",
          b ? `${(b.ms / 1000).toFixed(3)} s` : "READY",
        ),
      );
      if (s.settings.rule !== "points")
        body.append(ruleProgressNode(p, s.settings));
      card.append(top, body, element("div", "podium-light"));
      return card;
    }),
  );
  renderBuzzer();
}
socket.on("connect", () => {
  updateConnection();
  if (state && !inSession()) showLobby(state.code);
});
socket.on("disconnect", () => {
  updateConnection();
  pendingPlay = pendingBuzz = false;
  player?.pauseVideo();
  playerIntroAudio.reset();
  musicVisualizer.render();
  if (state) {
    if (host()) renderHostControls();
    else renderBuzzer();
  }
  toast("接続が切れました。再接続後、部屋に入り直してください");
});
socket.on("state", (s) => {
  const prev = state;
  state = s;
  clockOffset = s.serverNow - Date.now();
  customization.playNewBuzzes(s, prev);
  const isHost = host();
  document.body.dataset.screen = isHost ? "host" : "player";
  document.body.dataset.mode = s.mode;
  $("lobby").hidden = true;
  $("room").hidden = false;
  $("hostScreen").hidden = !isHost;
  $("playerScreen").hidden = isHost;
  history.replaceState(null, "", "/?room=" + s.code);
  if (isHost) renderHost(s, prev);
  else renderPlayer(s);
  renderGameRule(s, socket.id);
  if (prev && prev.code !== s.code) playerIntroAudio.reset();
  playerIntroAudio.sync();
  musicVisualizer.render();
  if (player && (s.phase !== "playing" || !isHost) && !pendingPlay)
    player.pauseVideo();
  if (
    player &&
    prev &&
    (prev.code !== s.code ||
      prev.index !== s.index ||
      prev.round !== s.round ||
      (s.phase === "ready" && prev.phase !== "ready"))
  ) {
    pendingPlay = false;
    player.stopVideo();
    lastVideo = "";
  }
  prepareIntroTitle();
});
function reportIntroTitle() {
  if (
    !host() ||
    state.mode !== "intro" ||
    state.question?.titleStatus === "ready" ||
    !player?.getVideoData
  )
    return;
  const data = player.getVideoData(),
    id = videoId(state.question?.url || "");
  const key = `${state.roundId}:${data.video_id}:${data.title}`;
  if (data.video_id === id && data.title?.trim() && reportedTitle !== key) {
    reportedTitle = key;
    send("videoTitle", {
      roundId: state.roundId,
      videoId: id,
      title: data.title.slice(0, 500),
    });
  }
}
function prepareIntroTitle() {
  if (
    !host() ||
    state.mode !== "intro" ||
    !ytReady ||
    !player?.cueVideoById ||
    state.phase !== "ready" ||
    playlistLoading ||
    !state.question ||
    state.question.titleStatus === "ready" ||
    cuedTitleRound === state.roundId
  )
    return;
  const id = videoId(state.question.url);
  if (!id) return;
  cuedTitleRound = state.roundId;
  player.cueVideoById({ videoId: id, startSeconds: state.question.start || 0 });
}
function ensureYouTube() {
  if (!host() || state.mode !== "intro" || player) return;
  if (window.YT?.Player) {
    player = new YT.Player("player", {
      height: "180",
      width: "320",
      playerVars: { playsinline: 1 },
      events: {
        onReady: () => {
          ytReady = true;
          if (host()) renderHostControls();
          prepareIntroTitle();
        },
        onStateChange: async (e) => {
          reportIntroTitle();
          if ([YT.PlayerState.PLAYING, YT.PlayerState.CUED].includes(e.data))
            setTimeout(reportIntroTitle, 300);
          if (e.data === YT.PlayerState.PLAYING) {
            if (pendingPlay && host()) {
              pendingPlay = false;
              if (!(await send("start"))) player.pauseVideo();
              if (host()) renderHostControls();
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
          if (host()) renderHostControls();
          toast(
            "YouTube動画を再生できません。埋め込み許可やURLを確認してください",
          );
          if (state?.phase === "playing") send("pause");
        },
      },
    });
  } else requestYouTubeApi();
}
function requestYouTubeApi() {
  if (!document.getElementById("yt-api")) {
    const script = document.createElement("script");
    script.id = "yt-api";
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      script.remove();
      playerIntroAudio.onApiError();
      toast("YouTubeに接続できません。通信設定を確認してください");
    };
    document.head.append(script);
  }
}
window.onYouTubeIframeAPIReady = () => {
  ensureYouTube();
  playerIntroAudio.onApiReady();
};
function tick() {
  if (state) {
    const ms =
      state.phase === "playing"
        ? Math.max(0, Date.now() + clockOffset - state.startedAt)
        : state.elapsed || 0;
    const text = (ms / 1000).toFixed(3);
    $(host() ? "hostTimer" : "playerTimer").textContent = text;
  }
  requestAnimationFrame(tick);
}
updateConnection();
tick();
