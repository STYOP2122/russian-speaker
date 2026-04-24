const els = {
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnMute: document.getElementById("btnMute"),
  btnCam: document.getElementById("btnCam"),
  optVideo: document.getElementById("optVideo"),
  btnSideRu: document.getElementById("btnSideRu"),
  btnSideAm: document.getElementById("btnSideAm"),
  sideBadge: document.getElementById("sideBadge"),
  btnConnect: document.getElementById("btnConnect"),
  btnDisconnect: document.getElementById("btnDisconnect"),
  status: document.getElementById("status"),
  envHint: document.getElementById("envHint"),
  localVideo: document.getElementById("localVideo"),
  remoteVideo: document.getElementById("remoteVideo"),
  remoteAudio: document.getElementById("remoteAudio"),
};

let pc = null;
let localStream = null;
let remoteStream = new MediaStream();
let remoteVideoStream = new MediaStream();
let remoteAudioStream = new MediaStream();
let side = null; // "ru" | "am"
let ws = null;
let clientId = null;
let pendingIceCandidates = [];

function getSignalWsUrl() {
  // After deploying the Worker, open the site as:
  // https://.../?signal=wss://YOUR_WORKER_DOMAIN/ws
  const u = new URL(location.href);
  return u.searchParams.get("signal");
}

function disconnectAuto() {
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  ws = null;
  clientId = null;
  pendingIceCandidates = [];
  resetPeerConnection();
  enableControls();
}

function resetPeerConnection() {
  // Reset WebRTC state between calls without tearing down local mic/camera.
  if (pc) {
    try {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.close();
    } catch {
      // ignore
    }
  }
  pc = null;

  remoteStream = new MediaStream();
  remoteVideoStream = new MediaStream();
  remoteAudioStream = new MediaStream();
  if (els.remoteVideo) els.remoteVideo.srcObject = remoteVideoStream;
  if (els.remoteAudio) els.remoteAudio.srcObject = remoteAudioStream;

  // Fresh PC for next connect.
  createPeerConnection();
  rebindLocalTracks();
}

function rebindLocalTracks() {
  if (!localStream) return;
  const peer = createPeerConnection();
  const existing = new Set(peer.getSenders().map((s) => s.track).filter(Boolean).map((t) => t.id));
  for (const track of localStream.getTracks()) {
    if (existing.has(track.id)) continue;
    peer.addTrack(track, localStream);
  }
}

function setSide(next) {
  side = next;
  if (side === "ru") {
    els.sideBadge.textContent = "🇷🇺 Россия (создаёт первый код)";
    els.btnSideRu?.classList.remove("ghost");
    els.btnSideAm?.classList.add("ghost");
  } else if (side === "am") {
    els.sideBadge.textContent = "🇦🇲 Армения (отвечает на первый код)";
    els.btnSideAm?.classList.remove("ghost");
    els.btnSideRu?.classList.add("ghost");
  } else {
    els.sideBadge.textContent = "Сторона не выбрана";
  }
  enableControls();
}

function connectAuto() {
  const base = getSignalWsUrl();
  if (!base) throw new Error("Нужен параметр ?signal=wss://.../ws (URL Worker)");
  if (!side) throw new Error("Сначала выберите 🇷🇺 или 🇦🇲");
  if (!localStream) throw new Error("Сначала включите микрофон/камеру");

  const url = new URL(base);
  url.searchParams.set("room", "ru-am");
  url.searchParams.set("side", side);

  disconnectAuto();
  clientId = crypto.randomUUID();
  ws = new WebSocket(url.toString());

  ws.onopen = () => {
    setStatus("Подключено. Жду вторую сторону…");
    ws.send(JSON.stringify({ t: "join", from: clientId, side }));
    void ensureMediaPlayback();
    enableControls();
  };

  ws.onclose = () => {
    setStatus("Отключено");
    // Avoid recursion: close already happened.
    ws = null;
    clientId = null;
    pendingIceCandidates = [];
    resetPeerConnection();
    enableControls();
  };

  ws.onerror = () => {
    setStatus("Ошибка сигналинга");
    // onerror does not always imply onclose; reset locally to allow reconnect.
    ws = null;
    clientId = null;
    pendingIceCandidates = [];
    resetPeerConnection();
    enableControls();
  };

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.t === "denied") {
        setStatus(
          msg.reason === "side-taken"
            ? "Эта сторона уже занята (🇷🇺 или 🇦🇲). Попросите собеседника отключиться или выберите другую сторону."
            : "Подключение отклонено сервером."
        );
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      if (msg.t === "peer-left") {
        setStatus("Собеседник отключился");
        return;
      }
      if (msg.t === "ready") {
        if (msg.initiator === clientId) {
          setStatus("Обе стороны онлайн. Стартую звонок…");
          await startAutoCallAsInitiator();
        } else {
          setStatus("Обе стороны онлайн. Жду звонок…");
        }
        return;
      }
      if (msg.t === "sdp" && msg.desc) {
        await onRemoteSdp(msg.desc);
        return;
      }
      if (msg.t === "ice" && msg.candidate) {
        await addRemoteIceCandidate(msg.candidate);
      }
    } catch (e) {
      setStatus(`Ошибка: ${e?.message ?? e}`);
    }
  };
}

function describeGetUserMediaError(e) {
  const name = e?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Доступ к микрофону/камере запрещён. Проверьте разрешения сайта в браузере и настройки приватности Windows.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Устройство не найдено. Похоже, в системе нет доступного микрофона (или он отключён/занят). Проверьте Windows: Параметры → Система → Звук → Ввод (выберите микрофон) и разрешения для браузера.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Не удалось запустить микрофон/камеру (возможно, устройство занято другой программой). Закройте приложения, которые используют микрофон/камеру, и попробуйте снова.";
  }
  return `Не удалось получить доступ к медиа: ${e?.message ?? e}`;
}

function setStatus(text) {
  if (!els.status) {
    // Fallback if markup is missing/outdated.
    console.info(text);
    return;
  }
  els.status.textContent = text;
}

window.addEventListener("error", (ev) => {
  try {
    setStatus(`Ошибка JS: ${ev?.message ?? ev}`);
  } catch {
    // ignore
  }
});
window.addEventListener("unhandledrejection", (ev) => {
  try {
    setStatus(`Ошибка Promise: ${ev?.reason?.message ?? ev?.reason ?? ev}`);
  } catch {
    // ignore
  }
});

function updateEnvHint() {
  if (!els.envHint) return;
  const secure = Boolean(window.isSecureContext);
  const hasGUM = Boolean(navigator.mediaDevices?.getUserMedia);
  const parts = [];
  parts.push(secure ? "Контекст: HTTPS (нормально для WebRTC)." : "Контекст: НЕ secure (часто getUserMedia не работает). Откройте сайт по https://…");
  parts.push(hasGUM ? "getUserMedia: доступен." : "getUserMedia: недоступен в этом браузере/режиме.");
  els.envHint.textContent = parts.join(" ");
}

function summarizeStream(stream) {
  if (!stream) return "нет";
  const v = stream.getVideoTracks().length;
  const a = stream.getAudioTracks().length;
  return `видео:${v}, аудио:${a}`;
}

async function tryPlayVideo(el) {
  if (!el) return;
  try {
    await el.play();
  } catch {
    // Autoplay policies: user gesture already happened for getUserMedia/connect,
    // but keep this resilient across browsers.
  }
}

async function tryPlayAudio(el) {
  if (!el) return;
  try {
    await el.play();
  } catch {
    // ignore
  }
}

async function ensureMediaPlayback() {
  // Video can stay muted for autoplay policies; audio is played via <audio>.
  if (els.remoteVideo) els.remoteVideo.muted = true;
  if (els.remoteAudio) els.remoteAudio.muted = false;
  await tryPlayVideo(els.localVideo);
  await tryPlayVideo(els.remoteVideo);
  await tryPlayAudio(els.remoteAudio);
}

function enableControls() {
  const hasMedia = Boolean(localStream);
  const hasPc = Boolean(pc);
  const connected = Boolean(ws && ws.readyState === WebSocket.OPEN);

  els.btnStop.disabled = !hasMedia;
  els.btnMute.disabled = !hasMedia;
  els.btnCam.disabled = !hasMedia || localStream?.getVideoTracks().length === 0;

  els.btnConnect.disabled = !hasPc || !side || !hasMedia || connected;
  els.btnDisconnect.disabled = !connected;
}

function createPeerConnection() {
  if (pc) return pc;

  // GitHub Pages friendly mode: no TURN by default.
  // In some networks, a TURN server is required for connectivity.
  pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  });

  remoteStream = new MediaStream();
  remoteVideoStream = new MediaStream();
  remoteAudioStream = new MediaStream();
  els.remoteVideo.srcObject = remoteVideoStream;
  if (els.remoteAudio) els.remoteAudio.srcObject = remoteAudioStream;

  pc.ontrack = (ev) => {
    const incoming = ev.streams?.[0];
    if (!incoming) return;
    let addedVideo = false;
    let addedAudio = false;
    for (const track of incoming.getTracks()) {
      // Avoid duplicate tracks if the browser fires multiple events.
      const exists = remoteStream.getTracks().some((t) => t.id === track.id);
      if (!exists) remoteStream.addTrack(track);

      if (track.kind === "video") {
        const existsV = remoteVideoStream.getTracks().some((t) => t.id === track.id);
        if (!existsV) {
          remoteVideoStream.addTrack(track);
          addedVideo = true;
        }
      } else if (track.kind === "audio") {
        const existsA = remoteAudioStream.getTracks().some((t) => t.id === track.id);
        if (!existsA) {
          remoteAudioStream.addTrack(track);
          addedAudio = true;
        }
      }
    }
    els.remoteVideo.srcObject = remoteVideoStream;
    if (els.remoteAudio) els.remoteAudio.srcObject = remoteAudioStream;
    void ensureMediaPlayback();
    setStatus(
      `Трек от собеседника: ${addedVideo || remoteVideoStream.getVideoTracks().length ? "видео" : "без видео"} + ${
        addedAudio || remoteAudioStream.getAudioTracks().length ? "аудио" : "без аудио"
      }`
    );
  };

  pc.onconnectionstatechange = () => {
    setStatus(`Связь: ${pc.connectionState}`);
  };

  pc.onicegatheringstatechange = () => {
    setStatus(`ICE: ${pc.iceGatheringState}`);
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "ice", from: clientId, candidate: ev.candidate }));
    }
  };

  return pc;
}

async function flushPendingIceCandidates() {
  const peer = createPeerConnection();
  if (!peer.remoteDescription) return;
  while (pendingIceCandidates.length) {
    const c = pendingIceCandidates.shift();
    try {
      await peer.addIceCandidate(c);
    } catch {
      // ignore bad candidates
    }
  }
}

async function addRemoteIceCandidate(candidate) {
  const peer = createPeerConnection();
  if (!peer.remoteDescription) {
    pendingIceCandidates.push(candidate);
    return;
  }
  await peer.addIceCandidate(candidate);
}

// Manual flow removed: auto signaling via WebSocket.

async function waitIceGatheringComplete(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const onChange = () => {
      if (peer.iceGatheringState === "complete") {
        peer.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

async function startAutoCallAsInitiator() {
  const peer = createPeerConnection();
  setStatus("Создаю Offer (авто)…");
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  ws.send(JSON.stringify({ t: "sdp", from: clientId, desc: peer.localDescription }));
}

async function onRemoteSdp(desc) {
  const peer = createPeerConnection();
  await peer.setRemoteDescription(desc);
  await flushPendingIceCandidates();
  if (desc.type === "offer") {
    setStatus("Получил Offer → создаю Answer (авто)…");
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    ws.send(JSON.stringify({ t: "sdp", from: clientId, desc: peer.localDescription }));
  } else {
    setStatus("Получил Answer (авто)");
  }
}

async function startMedia() {
  const wantVideo = Boolean(els.optVideo?.checked);
  const peer = createPeerConnection();

  updateEnvHint();
  if (!window.isSecureContext) {
    throw new Error("Страница открыта не по HTTPS (или внутри WebView). Откройте GitHub Pages по https://… в обычном браузере.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("В этом браузере нет navigator.mediaDevices.getUserMedia (часто это встроенный браузер Telegram/Instagram). Откройте ссылку в Chrome/Safari.");
  }

  setStatus(wantVideo ? "Запрашиваю доступ к камере/микрофону…" : "Запрашиваю доступ к микрофону…");

  // Important: avoid capturing microphone audio twice (some cameras expose a mic track too).
  // We keep a single mic audio track + a separate video-only track when camera is enabled.
  if (wantVideo) {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      localStream = new MediaStream();
      for (const t of mic.getTracks()) localStream.addTrack(t);
      for (const t of cam.getTracks()) localStream.addTrack(t);
    } catch (e) {
      // Camera failed: fall back to mic-only
      localStream = mic;
      if (els.optVideo) els.optVideo.checked = false;
      setStatus("Камера недоступна — работаем только микрофоном…");
    }
  } else {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
  els.localVideo.srcObject = localStream;
  void tryPlayVideo(els.localVideo);

  for (const track of localStream.getTracks()) peer.addTrack(track, localStream);

  setStatus(`Медиа включено (${summarizeStream(localStream)})`);
  void ensureMediaPlayback();
  enableControls();
}

function stopMedia() {
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
    localStream = null;
  }

  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.close();
    pc = null;
  }

  els.localVideo.srcObject = null;
  remoteStream = new MediaStream();
  remoteVideoStream = new MediaStream();
  remoteAudioStream = new MediaStream();
  els.remoteVideo.srcObject = remoteVideoStream;
  if (els.remoteAudio) els.remoteAudio.srcObject = remoteAudioStream;

  pendingIceCandidates = [];
  setStatus("Остановлено");
  enableControls();
}

function toggleAudio() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length === 0) return;
  const enabledNow = audioTracks.every((t) => t.enabled);
  const next = !enabledNow;
  for (const t of audioTracks) {
    t.enabled = next;
  }
  els.btnMute.textContent = next ? "Mute" : "Unmute";
}

async function toggleVideo() {
  if (!localStream) return;
  const peer = createPeerConnection();
  const videoTracks = localStream.getVideoTracks();
  const sender = peer.getSenders().find((s) => s.track && s.track.kind === "video");

  if (videoTracks.length === 0) {
    // User started audio-only; allow turning camera on later.
    if (!els.optVideo) return;
    els.optVideo.checked = true;
    try {
      const vStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      const vTrack = vStream.getVideoTracks()[0];
      localStream.addTrack(vTrack);
      if (sender) await sender.replaceTrack(vTrack);
      else peer.addTrack(vTrack, localStream);
      els.btnCam.textContent = "Cam off";
      setStatus(`Камера включена (${summarizeStream(localStream)})`);
      enableControls();
    } catch (e) {
      setStatus(describeGetUserMediaError(e));
    }
    return;
  }

  const enabledNow = videoTracks.every((t) => t.enabled);
  const next = !enabledNow;
  for (const t of videoTracks) t.enabled = next;
  els.btnCam.textContent = next ? "Cam off" : "Cam on";
}

// Legacy manual helpers removed.

function wireUi() {
  els.btnStart.addEventListener("click", async () => {
    try {
      setStatus("Нажата кнопка старта медиа…");
      await startMedia();
    } catch (e) {
      setStatus(describeGetUserMediaError(e));
    }
  });

  els.btnStop.addEventListener("click", () => stopMedia());
  els.btnMute.addEventListener("click", () => toggleAudio());
  els.btnCam.addEventListener("click", () => toggleVideo());

  els.btnSideRu?.addEventListener("click", () => setSide("ru"));
  els.btnSideAm?.addEventListener("click", () => setSide("am"));

  els.btnConnect?.addEventListener("click", () => {
    try {
      connectAuto();
    } catch (e) {
      setStatus(e?.message ?? String(e));
    }
  });
  els.btnDisconnect?.addEventListener("click", () => disconnectAuto());

  window.addEventListener("beforeunload", () => stopMedia());
}

function init() {
  updateEnvHint();
  if (!("RTCPeerConnection" in window)) {
    setStatus("Этот браузер не поддерживает WebRTC");
    return;
  }
  createPeerConnection();
  wireUi();
  enableControls();
  setSide(null);
  setStatus("Готово. Включите микрофон, выберите 🇷🇺/🇦🇲 и нажмите “Подключиться”.");
}

init();

