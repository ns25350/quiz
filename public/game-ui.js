const ruleNames = {
  points: "得点制",
  "seven-three": "7○3×",
  survival: "ライフバトル",
};
const $ = (id) => document.getElementById(id);
export function ruleDescription(settings) {
  if (settings.rule === "seven-three")
    return "7問正解で勝利。3問不正解で失格。";
  if (settings.rule === "survival")
    return `初期ライフ${settings.startingLives}。正解で他の全員−${settings.lifeDamage}。${settings.wrongLifeLoss ? `不正解で本人−${settings.wrongLifeLoss}。` : "不正解のライフ減少なし。"}最後の1人が勝利。`;
  return `正解${settings.correctPoints >= 0 ? "+" : ""}${settings.correctPoints}点 / 不正解${settings.wrongPoints}点`;
}
export function progressText(player, settings) {
  if (settings.rule === "seven-three")
    return `${player.correct ?? "—"} / 7 ○ · ${player.wrong ?? "—"} / 3 ×`;
  if (settings.rule === "survival")
    return `${player.lives ?? "—"} / ${settings.startingLives} LIFE`;
  return "";
}
export function statusText(player = {}, settings) {
  return player.status === "won"
    ? "勝利"
    : player.status === "eliminated"
      ? settings.rule === "seven-three"
        ? "失格"
        : "脱落"
      : player.status === "spectator"
        ? "観戦中"
        : "";
}
export function ruleProgressNode(player, settings) {
  const node = document.createElement("div");
  node.className = "rule-progress";
  node.textContent = progressText(player, settings);
  if (settings.rule === "survival" && player.lives !== null) {
    const meter = document.createElement("meter");
    meter.min = 0;
    meter.max = settings.startingLives;
    meter.value = player.lives;
    meter.setAttribute(
      "aria-label",
      `${player.name}の残りライフ ${player.lives}`,
    );
    node.append(meter);
  }
  return node;
}
export function renderGameRule(room, socketId) {
  const finished = room.game.status === "finished";
  for (const prefix of ["host", "player"]) {
    $(prefix + "RuleName").textContent = ruleNames[room.settings.rule];
    $(prefix + "RuleDescription").textContent = ruleDescription(room.settings);
    $(prefix + "RuleStrip").dataset.finished = String(finished);
    $(prefix + "GameResult").hidden = !finished;
    $(prefix + "GameResult").textContent = finished
      ? room.game.draw
        ? "ゲーム終了 · 勝者なし"
        : `${room.game.winners.map((p) => p.name).join("・")} の勝利！`
      : "";
  }
  const me = room.players.find((p) => p.id === socketId);
  $("myRuleProgress").textContent = me
    ? [statusText(me, room.settings), progressText(me, room.settings)]
        .filter(Boolean)
        .join(" · ")
    : "";
}
export function createMusicVisualizer({
  getRoom,
  inSession,
  getPlaybackState,
}) {
  for (let i = 0; i < 20; i++) {
    const bar = document.createElement("span");
    bar.style.setProperty("--bar-height", `${25 + ((i * 19 + 7) % 70)}%`);
    bar.style.setProperty("--bar-duration", `${520 + ((i * 73) % 450)}ms`);
    bar.style.setProperty("--bar-delay", `${-i * 97}ms`);
    $("musicBars").append(bar);
  }
  function render() {
    const room = getRoom(),
      playback = getPlaybackState();
    $("musicVisualizer").hidden = room?.mode !== "intro" || !room.question;
    let active = false,
      text = "イントロ待機中";
    if (!inSession()) text = "通信待ち";
    else if (room?.phase === "playing") {
      if (playback.enabled && room.settings.allowPlayerMusic) {
        active = playback.playing;
        text = playback.failed
          ? "端末の音声を再試行してください"
          : playback.playing
            ? playback.muted
              ? "端末はミュート中"
              : "この端末で再生中"
            : "端末の再生待ち";
      } else {
        active = true;
        text = "運営で再生中";
      }
    } else if (room?.phase === "buzzed") text = "早押しで停止";
    else if (room?.phase === "paused") text = "再生を一時停止";
    $("musicVisualizer").dataset.active = String(active);
    $("musicVisualStatus").textContent = text;
  }
  window.addEventListener("intro-audio-state", render);
  return { render };
}
