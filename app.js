const els = {
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnMute: document.getElementById("btnMute"),
  btnCam: document.getElementById("btnCam"),
  optVideo: document.getElementById("optVideo"),
  btnNewRoom: document.getElementById("btnNewRoom"),
  btnJoinRoom: document.getElementById("btnJoinRoom"),
  roomCode: document.getElementById("roomCode"),
  btnCreateOffer: document.getElementById("btnCreateOffer"),
  btnCreateAnswer: document.getElementById("btnCreateAnswer"),
  outSdp: document.getElementById("outSdp"),
  btnCopyOut: document.getElementById("btnCopyOut"),
  inSdp: document.getElementById("inSdp"),
  btnApplyIn: document.getElementById("btnApplyIn"),
  btnClearIn: document.getElementById("btnClearIn"),
  status: document.getElementById("status"),
  localVideo: document.getElementById("localVideo"),
  remoteVideo: document.getElementById("remoteVideo"),
};

let pc = null;
let localStream = null;
let remoteStream = new MediaStream();
let ws = null;
let currentRoom = null;
let clientId = null;

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
  els.status.textContent = text;
}

function getSignalingUrl() {
  // Set SIGNALING in URL like ?signal=wss://your-worker.example/ws
  // or fill in default once you deploy the Worker.
  const u = new URL(location.href);
  const fromQuery = u.searchParams.get("signal");
  return fromQuery || null;
}

function enableControls() {
  const hasMedia = Boolean(localStream);
  const hasPc = Boolean(pc);
  const hasWs = Boolean(ws && ws.readyState === WebSocket.OPEN);

  els.btnStop.disabled = !hasMedia;
  els.btnMute.disabled = !hasMedia;
  els.btnCam.disabled = !hasMedia || localStream?.getVideoTracks().length === 0;

  // Allow signaling even before media is granted (so Answer can be created).
  els.btnCreateOffer.disabled = !hasPc;
  els.btnCreateAnswer.disabled = !hasPc;
  els.btnApplyIn.disabled = !hasPc;
  els.btnClearIn.disabled = !hasPc;

  els.btnNewRoom.disabled = !hasPc;
  els.btnJoinRoom.disabled = !hasPc;
  if (els.roomCode) els.roomCode.disabled = !hasPc;

  els.btnCopyOut.disabled = !els.outSdp.value.trim();

  // In auto mode, creating offer/answer is driven by WS events.
  if (hasWs) {
    // Keep manual buttons available as fallback, but not required.
  }
}

function createPeerConnection() {
  if (pc) return pc;

  // GitHub Pages friendly mode: no TURN by default.
  // In some networks, a TURN server is required for connectivity.
  pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  });

  remoteStream = new MediaStream();
  els.remoteVideo.srcObject = remoteStream;

  pc.ontrack = (ev) => {
    for (const track of ev.streams[0].getTracks()) remoteStream.addTrack(track);
  };

  pc.onconnectionstatechange = () => {
    setStatus(`Связь: ${pc.connectionState}`);
  };

  pc.onicegatheringstatechange = () => {
    setStatus(`ICE: ${pc.iceGatheringState}`);
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    if (ws && ws.readyState === WebSocket.OPEN && currentRoom) {
      ws.send(
        JSON.stringify({
          t: "ice",
          room: currentRoom,
          from: clientId,
          candidate: ev.candidate,
        })
      );
    }
  };

  return pc;
}

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

function getSdpString(desc) {
  // Prefer short share code when compression is available.
  const json = JSON.stringify(desc);
  try {
    const code = encodeShortCode(json);
    if (code) return code;
  } catch {
    // ignore, fall back to JSON
  }
  return json;
}

function base64UrlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecodeToBytes(b64url) {
  let b64 = b64url.replaceAll("-", "+").replaceAll("_", "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeShortCode(jsonString) {
  // RS1 = Russian Speaker v1 share code.
  const pako = window.pako;
  if (!pako?.deflate) return null;
  const bytes = new TextEncoder().encode(jsonString);
  const deflated = pako.deflate(bytes);
  return `RS1:${base64UrlEncode(deflated)}`;
}

function decodeShortCodeToJson(text) {
  const pako = window.pako;
  if (!pako?.inflate) throw new Error("Сжатый код не поддерживается (нет pako)");
  const raw = text.trim();
  if (!raw.startsWith("RS1:")) return null;
  const payload = raw.slice(4).trim();
  const bytes = base64UrlDecodeToBytes(payload);
  const inflated = pako.inflate(bytes);
  return new TextDecoder().decode(inflated);
}

function parseSdpString(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Пустой код");

  // Support short share codes.
  const decoded = decodeShortCodeToJson(trimmed);
  if (decoded) return parseSdpString(decoded);

  // Be tolerant to copy/paste where users include extra text around JSON.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const candidate =
    firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace
      ? trimmed.slice(firstBrace, lastBrace + 1)
      : trimmed;

  try {
    const obj = JSON.parse(candidate);
    if (!obj?.type || !obj?.sdp) {
      throw new Error("Неверный формат (ожидается JSON с полями type и sdp)");
    }
    return obj;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/Unterminated string|Unexpected end of JSON|Unexpected token/.test(msg)) {
      throw new Error(
        "Код вставлен не полностью (JSON обрезан/повреждён). Скопируйте код целиком: от '{' до '}'."
      );
    }
    throw e;
  }
}

async function startMedia() {
  const wantVideo = Boolean(els.optVideo?.checked);
  const peer = createPeerConnection();

  setStatus(wantVideo ? "Запрашиваю доступ к камере/микрофону…" : "Запрашиваю доступ к микрофону…");

  const constraints = { audio: true, video: wantVideo };
  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    // Common case: user wants video but camera is blocked/unavailable.
    if (wantVideo) {
      setStatus("Камера недоступна — пробую только микрофон…");
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (els.optVideo) els.optVideo.checked = false;
    } else {
      throw e;
    }
  }
  els.localVideo.srcObject = localStream;

  for (const track of localStream.getTracks()) peer.addTrack(track, localStream);

  setStatus("Медиа включено");
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
  els.remoteVideo.srcObject = remoteStream;

  els.outSdp.value = "";
  setStatus("Остановлено");
  enableControls();
}

function toggleAudio() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  const enabledNow = audioTracks.some((t) => t.enabled);
  for (const t of audioTracks) t.enabled = !enabledNow;
  els.btnMute.textContent = enabledNow ? "Unmute" : "Mute";
}

function toggleVideo() {
  if (!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  const enabledNow = videoTracks.some((t) => t.enabled);
  for (const t of videoTracks) t.enabled = !enabledNow;
  els.btnCam.textContent = enabledNow ? "Cam on" : "Cam off";
}

async function createOffer() {
  const peer = createPeerConnection();
  setStatus("Создаю Offer…");
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitIceGatheringComplete(peer);
  els.outSdp.value = getSdpString(peer.localDescription);
  setStatus("Offer готов — отправьте код собеседнику");
  enableControls();
}

async function applyRemoteSdp() {
  const peer = createPeerConnection();
  const remoteDesc = parseSdpString(els.inSdp.value);
  setStatus(`Применяю ${remoteDesc.type}…`);
  await peer.setRemoteDescription(remoteDesc);
  setStatus(`${remoteDesc.type} применён`);
  enableControls();
}

async function createAnswer() {
  const peer = createPeerConnection();
  if (!peer.remoteDescription) {
    throw new Error("Сначала примените Offer от собеседника");
  }
  setStatus("Создаю Answer…");
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await waitIceGatheringComplete(peer);
  els.outSdp.value = getSdpString(peer.localDescription);
  setStatus("Answer готов — отправьте код обратно");
  enableControls();
}

function genRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  crypto.getRandomValues(new Uint8Array(6)).forEach((b) => {
    out += alphabet[b % alphabet.length];
  });
  return out;
}

function connectWs(room) {
  const url = getSignalingUrl();
  if (!url) {
    throw new Error(
      "Авто-режим не настроен: нет адреса сигналинга. После деплоя Worker добавьте ?signal=wss://.../ws"
    );
  }
  if (ws) ws.close();
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("room", room);
  ws = new WebSocket(wsUrl.toString());
  currentRoom = room;
  clientId = crypto.randomUUID();

  ws.onopen = () => {
    setStatus(`Сигналинг подключён. Комната: ${currentRoom}`);
    ws.send(JSON.stringify({ t: "join", room: currentRoom, from: clientId }));
    enableControls();
  };

  ws.onclose = () => {
    setStatus("Сигналинг отключён");
    enableControls();
  };

  ws.onerror = () => {
    setStatus("Ошибка сигналинга");
  };

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.t === "peer-joined") {
        // If we created the room, initiate offer.
        if (msg.initiator === clientId) {
          const peer = createPeerConnection();
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          ws.send(
            JSON.stringify({
              t: "sdp",
              room: currentRoom,
              from: clientId,
              desc: peer.localDescription,
            })
          );
          setStatus("Отправил Offer (авто)");
        }
        return;
      }

      if (msg.t === "sdp" && msg.desc) {
        const peer = createPeerConnection();
        await peer.setRemoteDescription(msg.desc);
        if (msg.desc.type === "offer") {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          ws.send(
            JSON.stringify({
              t: "sdp",
              room: currentRoom,
              from: clientId,
              desc: peer.localDescription,
            })
          );
          setStatus("Получил Offer → отправил Answer (авто)");
        } else {
          setStatus("Получил Answer (авто)");
        }
        return;
      }

      if (msg.t === "ice" && msg.candidate) {
        const peer = createPeerConnection();
        await peer.addIceCandidate(msg.candidate);
        return;
      }
    } catch (e) {
      setStatus(`Ошибка сообщения: ${e?.message ?? e}`);
    }
  };
}

async function copyOut() {
  const text = els.outSdp.value.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("Скопировано в буфер обмена");
}

function clearIn() {
  els.inSdp.value = "";
  enableControls();
}

function wireUi() {
  els.btnStart.addEventListener("click", async () => {
    try {
      await startMedia();
    } catch (e) {
      setStatus(describeGetUserMediaError(e));
    }
  });

  els.btnStop.addEventListener("click", () => stopMedia());
  els.btnMute.addEventListener("click", () => toggleAudio());
  els.btnCam.addEventListener("click", () => toggleVideo());

  els.btnCreateOffer.addEventListener("click", async () => {
    try {
      await createOffer();
    } catch (e) {
      setStatus(`Ошибка Offer: ${e?.message ?? e}`);
    }
  });

  els.btnNewRoom?.addEventListener("click", () => {
    try {
      const code = genRoomCode();
      els.roomCode.value = code;
      connectWs(code);
    } catch (e) {
      setStatus(e?.message ?? String(e));
    }
  });

  els.btnJoinRoom?.addEventListener("click", () => {
    try {
      const code = (els.roomCode.value || "").trim().toUpperCase();
      if (!code) throw new Error("Введите код комнаты");
      connectWs(code);
    } catch (e) {
      setStatus(e?.message ?? String(e));
    }
  });

  els.btnApplyIn.addEventListener("click", async () => {
    try {
      await applyRemoteSdp();
    } catch (e) {
      setStatus(`Ошибка применения: ${e?.message ?? e}`);
    }
  });

  els.btnCreateAnswer.addEventListener("click", async () => {
    try {
      await createAnswer();
    } catch (e) {
      setStatus(`Ошибка Answer: ${e?.message ?? e}`);
    }
  });

  els.btnCopyOut.addEventListener("click", async () => {
    try {
      await copyOut();
    } catch (e) {
      setStatus(`Не удалось скопировать: ${e?.message ?? e}`);
    }
  });

  els.btnClearIn.addEventListener("click", () => clearIn());

  els.outSdp.addEventListener("input", () => enableControls());
  els.inSdp.addEventListener("input", () => enableControls());

  window.addEventListener("beforeunload", () => stopMedia());
}

function init() {
  if (!("RTCPeerConnection" in window)) {
    setStatus("Этот браузер не поддерживает WebRTC");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("В этом браузере недоступен доступ к микрофону/камере (getUserMedia)");
    return;
  }
  createPeerConnection();
  els.remoteVideo.srcObject = remoteStream;
  wireUi();
  enableControls();
  const url = getSignalingUrl();
  setStatus(
    url
      ? "Готово. Создайте комнату или подключитесь по коду."
      : "Готово. Авто-режим появится после деплоя сигналинга (Worker). Пока можно вручную/RS1."
  );
}

init();

