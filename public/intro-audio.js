export function createPlayerIntroAudio({
  getRoom,
  isPlayer,
  getClockOffset,
  videoId,
  requestApi,
}) {
  const $ = (id) => document.getElementById(id);
  let player,
    ready = false,
    enabled = false,
    muted = false;
  let loadedRound = "",
    commandedPhase = "",
    failed = false,
    activating = false;
  let failureMessage = "この動画を再生できません。運営に確認してください。";
  const savedVolume = Number(localStorage.getItem("quiz-intro-volume") ?? 60);
  let volume = Number.isFinite(savedVolume)
    ? Math.max(0, Math.min(100, savedVolume))
    : 60;
  const allowed = () =>
    isPlayer() &&
    getRoom()?.mode === "intro" &&
    getRoom().settings.allowPlayerMusic;
  const seconds = () => {
    const room = getRoom();
    const elapsed =
      room.phase === "playing"
        ? Math.max(0, Date.now() + getClockOffset() - room.startedAt)
        : room.elapsed;
    return (room.question?.start || 0) + (elapsed || 0) / 1000;
  };
  function render() {
    const visible = allowed();
    $("playerMusicArea").hidden = !visible;
    document.body.dataset.musicEnabled = String(visible && enabled);
    $("playerMusicPlayback").hidden = !enabled;
    $("mutePlayerMusic").hidden = !enabled;
    $("mutePlayerMusic").textContent = muted ? "ミュート解除" : "ミュート";
    $("mutePlayerMusic").setAttribute("aria-pressed", String(muted));
    $("enablePlayerMusic").hidden = enabled && ready && !activating && !failed;
    $("enablePlayerMusic").textContent = failed
      ? "音声を再試行"
      : enabled
        ? "再生を有効にする"
        : "この端末で聞く";
    $("playerMusicHelp").hidden = ready && !activating && !failed;
    const room = getRoom();
    $("playerMusicStatus").textContent = !enabled
      ? "この端末でも曲を聞けます。"
      : failed
        ? failureMessage
        : !ready
          ? "YouTubeを読み込み中…"
          : activating
            ? "音声の準備中… 再生されない場合は下の再生ボタンを押してください。"
            : muted || volume === 0
              ? "この端末の曲はミュート中です。"
              : room?.phase === "playing"
                ? "イントロ再生中 · 早押しで停止します。"
                : room?.phase === "buzzed"
                  ? "早押しで曲を停止しました。"
                  : room?.phase === "paused"
                    ? "運営が再生を一時停止しています。"
                    : "準備完了 · 運営の開始を待っています。";
    $("playerMusicVolume").value = volume;
    $("musicVolumeValue").value = `${volume}%`;
  }
  function applyVolume() {
    if (!ready) return;
    player.setVolume(volume);
    if (muted || volume === 0) player.mute();
    else player.unMute();
  }
  function sync(force = false) {
    if (!allowed() || !enabled) {
      if (ready && loadedRound) player.stopVideo();
      loadedRound = commandedPhase = "";
      render();
      return;
    }
    if (!ready) {
      ensurePlayer();
      render();
      return;
    }
    const room = getRoom(),
      id = videoId(room.question?.url || "");
    if (room.phase === "ready" || !id) {
      if (loadedRound) player.stopVideo();
      loadedRound = commandedPhase = "";
      activating = false;
      failed = false;
    } else if (room.phase === "playing") {
      if (
        force ||
        loadedRound !== room.roundId ||
        commandedPhase !== "playing"
      ) {
        const sameRound = loadedRound === room.roundId && !failed;
        failed = false;
        activating = true;
        loadedRound = room.roundId;
        commandedPhase = "playing";
        applyVolume();
        if (sameRound) {
          player.seekTo(seconds(), true);
          player.playVideo();
        } else player.loadVideoById({ videoId: id, startSeconds: seconds() });
      }
    } else if (commandedPhase !== room.phase || force) {
      commandedPhase = room.phase;
      activating = false;
      player.pauseVideo();
    }
    render();
  }
  function ensurePlayer() {
    if (!allowed() || !enabled || player) return;
    if (!window.YT?.Player) {
      requestApi();
      return;
    }
    player = new window.YT.Player("listenerPlayer", {
      height: "200",
      width: "240",
      playerVars: { playsinline: 1, controls: 1 },
      events: {
        onReady: () => {
          ready = true;
          applyVolume();
          sync();
        },
        onStateChange: (event) => {
          if (event.data === window.YT.PlayerState.PLAYING) {
            if (!allowed() || !enabled || getRoom()?.phase !== "playing")
              player.pauseVideo();
            else {
              activating = false;
              failed = false;
              render();
            }
          } else if (
            event.data === window.YT.PlayerState.PAUSED &&
            getRoom()?.phase === "playing"
          ) {
            activating = true;
            render();
          } else if (event.data === window.YT.PlayerState.ENDED) {
            activating = true;
            render();
          }
        },
        onAutoplayBlocked: () => {
          activating = true;
          render();
        },
        onError: () => {
          failureMessage = "この動画を再生できません。運営に確認してください。";
          failed = true;
          activating = false;
          render();
        },
      },
    });
  }
  $("enablePlayerMusic").onclick = () => {
    enabled = true;
    muted = false;
    activating = true;
    if (!ready) failed = false;
    render();
    applyVolume();
    sync(true);
  };
  $("mutePlayerMusic").onclick = () => {
    muted = !muted;
    applyVolume();
    render();
  };
  $("playerMusicVolume").oninput = (e) => {
    volume = Number(e.target.value);
    localStorage.setItem("quiz-intro-volume", String(volume));
    applyVolume();
    render();
  };
  setInterval(() => {
    if (
      allowed() &&
      enabled &&
      ready &&
      !failed &&
      getRoom().phase === "playing" &&
      player.getPlayerState() === window.YT.PlayerState.PLAYING &&
      Math.abs(player.getCurrentTime() - seconds()) > 1.25
    )
      player.seekTo(seconds(), true);
  }, 1000);
  function reset() {
    if (ready) player.stopVideo();
    enabled = activating = failed = false;
    loadedRound = commandedPhase = "";
    render();
  }
  return {
    sync,
    reset,
    onApiReady: ensurePlayer,
    onApiError: () => {
      failed = true;
      failureMessage =
        "YouTubeに接続できません。通信を確認して再試行してください。";
      render();
    },
  };
}
