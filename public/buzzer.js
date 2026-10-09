const storageKey = "quiz-buzzer-v1";
const defaults = {
  text: "早押し！",
  icon: "lightning",
  shape: "pill",
  color: "#c1f29b",
  opacity: 50,
  size: 100,
  position: "center",
  layout: "split",
  image: "",
  sound: "bell",
  volume: 50,
  hearSounds: true,
};
const choices = {
  icon: ["lightning", "star", "music", "none"],
  shape: ["pill", "rounded", "circle"],
  position: ["center", "left", "right"],
  layout: ["split", "stacked"],
  sound: ["bell", "pop", "arcade", "none"],
};
const icons = { lightning: "⚡", star: "★", music: "♪", none: "" };
function normalize(raw) {
  const prefs = { ...defaults };
  if (!raw || typeof raw !== "object") return prefs;
  for (const [key, options] of Object.entries(choices))
    if (options.includes(raw[key])) prefs[key] = raw[key];
  if (typeof raw.text === "string")
    prefs.text = raw.text.slice(0, 12) || defaults.text;
  if (/^#[a-f\d]{6}$/i.test(raw.color)) prefs.color = raw.color;
  for (const [key, min, max] of [
    ["opacity", 25, 85],
    ["size", 80, 140],
    ["volume", 0, 100],
  ])
    if (Number.isFinite(raw[key]))
      prefs[key] = Math.max(min, Math.min(max, raw[key]));
  if (typeof raw.hearSounds === "boolean") prefs.hearSounds = raw.hearSounds;
  if (
    typeof raw.image === "string" &&
    raw.image.length < 720000 &&
    /^data:image\/(png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(raw.image)
  )
    prefs.image = raw.image;
  return prefs;
}
function foreground(rgb, opacity) {
  const luminance = rgb
    .map((n, i) => (n * opacity + [21, 23, 37][i] * (1 - opacity)) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  return (luminance + 0.05) / 0.065 > 1.05 / (luminance + 0.05)
    ? "#1d2030"
    : "#f8f7ff";
}
export function createBuzzerCustomization({ getRoom, toast }) {
  let prefs, audio;
  try {
    prefs = normalize(JSON.parse(localStorage.getItem(storageKey)));
  } catch {
    prefs = { ...defaults };
  }
  const $ = (id) => document.getElementById(id);
  function unlockAudio() {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      audio ??= new Audio({ latencyHint: "interactive" });
      if (audio.state === "suspended") audio.resume().catch(() => {});
    } catch {}
  }
  function playSound(kind) {
    if (
      !prefs.hearSounds ||
      !getRoom()?.settings.allowPlayerSound ||
      !prefs.volume ||
      !audio ||
      audio.state !== "running"
    )
      return;
    const tones = {
      bell: [
        [880, 0, 0.11],
        [1320, 0.1, 0.16],
      ],
      pop: [[520, 0, 0.08]],
      arcade: [
        [660, 0, 0.07],
        [880, 0.07, 0.07],
        [1100, 0.14, 0.12],
      ],
    }[kind];
    if (!tones) return;
    const now = audio.currentTime;
    for (const [frequency, offset, duration] of tones) {
      const oscillator = audio.createOscillator(),
        gain = audio.createGain();
      oscillator.type = kind === "arcade" ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(frequency, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(
        (0.12 * prefs.volume) / 100,
        now + offset + 0.01,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + duration + 0.02);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    }
  }
  function apply() {
    const rgb = [1, 3, 5].map((i) => parseInt(prefs.color.slice(i, i + 2), 16));
    for (const id of ["buzz", "buzzPreview"]) {
      const button = $(id);
      button.dataset.shape = prefs.shape;
      button.dataset.customImage = String(!!prefs.image);
      button.style.setProperty("--buzz-rgb", rgb.join(","));
      button.style.setProperty("--buzz-opacity", prefs.opacity / 100);
      button.style.setProperty("--buzz-scale", prefs.size / 100);
      button.style.setProperty(
        "--buzz-text",
        foreground(rgb, prefs.opacity / 100),
      );
    }
    for (const [id, icon] of [
      ["buzzIcon", prefs.icon],
      ["previewIcon", prefs.icon],
    ]) {
      $(id).textContent = icons[icon];
      $(id).hidden = icon === "none" || !!prefs.image;
    }
    for (const id of ["buzzImage", "previewImage"]) {
      $(id).hidden = !prefs.image;
      if (prefs.image) $(id).src = prefs.image;
      else $(id).removeAttribute("src");
    }
    $("previewLabel").textContent = prefs.text;
    $("buzzerDock").dataset.position = prefs.position;
    document.body.dataset.playerLayout = prefs.layout;
    document.body.style.setProperty(
      "--buzzer-reserve",
      `${Math.max(200, ((prefs.shape === "circle" ? 164 : 104) * prefs.size) / 100 + 100)}px`,
    );
    $("opacityValue").value = `${100 - prefs.opacity}% 透過`;
    $("sizeValue").value = `${prefs.size}%`;
    $("volumeValue").value = `${prefs.volume}%`;
    window.dispatchEvent(new Event("buzzer-preferences"));
  }
  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(prefs));
      $("playerSettingsDialog").querySelector(".settings-saved").textContent =
        "設定をこの端末に保存しました";
    } catch {
      toast("端末に保存できませんでした。現在の画面には反映しています。");
    }
    apply();
  }
  const fields = {
    buttonText: "text",
    buttonIcon: "icon",
    buttonShape: "shape",
    buttonColor: "color",
    buttonOpacity: "opacity",
    buttonSize: "size",
    buttonPosition: "position",
    playerLayout: "layout",
    buttonSound: "sound",
    soundVolume: "volume",
    hearSounds: "hearSounds",
  };
  function syncForm() {
    for (const [id, key] of Object.entries(fields)) {
      if ($(id).type === "checkbox") $(id).checked = prefs[key];
      else $(id).value = key === "opacity" ? 100 - prefs[key] : prefs[key];
    }
    permission();
  }
  for (const [id, key] of Object.entries(fields))
    $(id).addEventListener("input", () => {
      const input = $(id);
      prefs = normalize({
        ...prefs,
        [key]:
          input.type === "checkbox"
            ? input.checked
            : input.type === "range"
              ? key === "opacity"
                ? 100 - Number(input.value)
                : Number(input.value)
              : input.value,
      });
      persist();
    });
  $("openPlayerSettings").onclick = () => {
    syncForm();
    $("playerSettingsDialog").showModal();
    unlockAudio();
  };
  $("resetPlayerSettings").onclick = () => {
    prefs = { ...defaults };
    syncForm();
    persist();
  };
  $("removeButtonImage").onclick = () => {
    prefs.image = "";
    $("buttonImage").value = "";
    persist();
  };
  $("buttonImage").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (
      file.size > 500000 ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ) {
      toast("PNG・JPEG・WebPの500KB以下の画像を選んでください");
      e.target.value = "";
      return;
    }
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const img = new Image();
      img.src = data;
      await img.decode();
      prefs = normalize({ ...prefs, image: data });
      persist();
    } catch {
      toast("画像を読み込めませんでした");
    }
    e.target.value = "";
  };
  $("testSound").onclick = () => {
    unlockAudio();
    setTimeout(() => playSound(prefs.sound), 60);
  };
  function permission() {
    const allowed = !!getRoom()?.settings.allowPlayerSound;
    $("buttonSound").disabled = !allowed;
    $("testSound").disabled = !allowed;
    $("soundPermissionNote").textContent = allowed
      ? "選んだ早押し音が、効果音をオンにした端末で鳴ります。"
      : "運営がプレイヤーの効果音をオフにしています。";
  }
  function playNewBuzzes(next, previous) {
    permission();
    if (
      !previous ||
      previous.code !== next.code ||
      previous.roundId !== next.roundId
    )
      return;
    const old = new Set(previous.buzzes.map((b) => b.id));
    for (const b of next.buzzes) if (!old.has(b.id)) playSound(b.sound);
  }
  apply();
  return {
    get preferences() {
      return prefs;
    },
    unlockAudio,
    playNewBuzzes,
    permission,
  };
}
