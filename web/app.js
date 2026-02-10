// TeleTalkie — app.js

// ── Протокол (первый байт) ──
const MSG = {
  // Client → Server
  PTT_ON: 0x01,
  PTT_OFF: 0x02,
  MEDIA_CHUNK: 0x03,
  // Server → Client
  PTT_GRANTED: 0x10,
  PTT_DENIED: 0x11,
  PTT_RELEASED: 0x12,
  RELAY_CHUNK: 0x13,
  PEER_INFO: 0x14,
};

// ── DOM ──
const loginScreen = document.getElementById("login-screen");
const roomScreen = document.getElementById("room-screen");
const nameInput = document.getElementById("name-input");
const roomInput = document.getElementById("room-input");
const joinBtn = document.getElementById("join-btn");
const loginError = document.getElementById("login-error");
const roomNameEl = document.getElementById("room-name");
const userNameEl = document.getElementById("user-name");
const pttBtn = document.getElementById("ptt-btn");
const statusEl = document.getElementById("status");
const remoteVideo = document.getElementById("remote-video");
const talkerLabel = document.getElementById("talker-label");
const talkerNameEl = document.getElementById("talker-name");
const noStreamEl = document.getElementById("no-stream");
const peersList = document.getElementById("peers-list");

// ── Состояние ──
let ws = null;
let localStream = null; // кэшированный MediaStream (камера+микрофон)
let recorder = null; // MediaRecorder
let pttState = "idle"; // idle | requesting | talking

// ── MSE состояние ──
let mediaSource = null;
let sourceBuffer = null;
let chunkQueue = [];
let mseReady = false;

// ── Выбор mimeType для MediaRecorder ──
const MIME_CANDIDATES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMimeType() {
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

// ── Экран входа ──
joinBtn.addEventListener("click", handleJoin);

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") roomInput.focus();
});
roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleJoin();
});

function handleJoin() {
  const name = nameInput.value.trim();
  const room = roomInput.value.trim();

  if (!name || !room) {
    showLoginError("Введите имя и комнату");
    return;
  }

  joinBtn.disabled = true;
  joinBtn.textContent = "Подключение…";
  hideLoginError();

  connect(room, name);
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}

function hideLoginError() {
  loginError.hidden = true;
}

// ── WebSocket ──
function connect(roomID, name) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws?room=${encodeURIComponent(roomID)}&name=${encodeURIComponent(name)}`;

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    console.log("[ws] connected");
    showRoomScreen(roomID, name);
  });

  ws.addEventListener("close", (e) => {
    console.log("[ws] closed", e.code, e.reason);
    handleDisconnect();
  });

  ws.addEventListener("error", () => {
    console.error("[ws] error");
    joinBtn.disabled = false;
    joinBtn.textContent = "Войти";
    showLoginError("Не удалось подключиться");
  });

  ws.addEventListener("message", (e) => {
    handleMessage(e.data);
  });
}

function handleMessage(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return;

  const view = new Uint8Array(data);
  const type = view[0];
  const payload = view.slice(1);

  switch (type) {
    case MSG.PTT_GRANTED:
      onPTTGranted();
      break;
    case MSG.PTT_DENIED:
      onPTTDenied();
      break;
    case MSG.PTT_RELEASED:
      onPTTReleased();
      break;
    case MSG.RELAY_CHUNK:
      onRelayChunk(payload);
      break;
    case MSG.PEER_INFO:
      onPeerInfo(payload);
      break;
    default:
      console.warn("[ws] unknown message type:", type);
  }
}

// ── Переключение экранов ──
function showRoomScreen(roomID, name) {
  loginScreen.hidden = true;
  roomScreen.hidden = false;
  roomNameEl.textContent = roomID;
  userNameEl.textContent = name;
  pttBtn.disabled = false;
  statusEl.textContent = "Подключено";
}

function handleDisconnect() {
  stopTalking();
  releaseLocalStream();
  teardownMSE();
  pttState = "idle";

  if (!loginScreen.hidden) return; // ещё на экране входа

  statusEl.textContent = "Отключено";
  pttBtn.disabled = true;

  setTimeout(() => {
    roomScreen.hidden = true;
    loginScreen.hidden = false;
    joinBtn.disabled = false;
    joinBtn.textContent = "Войти";
    showLoginError("Соединение потеряно");
  }, 2000);
}

// ── PTT кнопка (mouse + touch) ──

function pttDown() {
  if (pttState !== "idle") return;
  pttState = "requesting";
  pttBtn.classList.add("talking");
  statusEl.textContent = "Запрос эфира…";
  wsSend(MSG.PTT_ON);
}

function pttUp() {
  if (pttState === "talking") {
    stopTalking();
    wsSend(MSG.PTT_OFF);
    pttState = "idle";
    pttBtn.classList.remove("talking");
    statusEl.textContent = "Подключено";
  } else if (pttState === "requesting") {
    // Отпустили до получения ответа — всё равно шлём OFF
    wsSend(MSG.PTT_OFF);
    pttState = "idle";
    pttBtn.classList.remove("talking");
    statusEl.textContent = "Подключено";
  }
}

// Mouse events
pttBtn.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // только левая кнопка
  e.preventDefault();
  pttDown();
});

document.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  pttUp();
});

// Touch events
pttBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  pttDown();
});

document.addEventListener("touchend", (e) => {
  pttUp();
});

document.addEventListener("touchcancel", (e) => {
  pttUp();
});

// Keyboard: пробел как PTT (когда фокус не на инпутах)
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && roomScreen && !roomScreen.hidden) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    if (!e.repeat) pttDown();
  }
});

document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && roomScreen && !roomScreen.hidden) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    pttUp();
  }
});

// ── PTT обработчики сообщений ──

function onPTTGranted() {
  console.log("[ptt] granted");
  if (pttState !== "requesting") {
    // Уже отпустили кнопку — сразу отпускаем эфир
    wsSend(MSG.PTT_OFF);
    return;
  }
  pttState = "talking";
  statusEl.textContent = "🔴 Вы в эфире";
  startTalking();
}

function onPTTDenied() {
  console.log("[ptt] denied");
  pttState = "idle";
  pttBtn.classList.remove("talking");
  statusEl.textContent = "Эфир занят";
  setTimeout(() => {
    if (pttState === "idle") statusEl.textContent = "Подключено";
  }, 1500);
}

function onPTTReleased() {
  console.log("[ptt] released");
  if (pttState === "idle") {
    statusEl.textContent = "Эфир свободен";
  }
  talkerLabel.hidden = true;
  noStreamEl.hidden = false;
  teardownMSE();
}

// ── MediaRecorder: захват и отправка чанков ──

async function ensureLocalStream() {
  if (localStream) return localStream;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    console.log("[media] got local stream");
    return localStream;
  } catch (err) {
    console.error("[media] getUserMedia failed:", err);
    statusEl.textContent = "Нет доступа к камере";
    throw err;
  }
}

function releaseLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
}

async function startTalking() {
  try {
    const stream = await ensureLocalStream();

    const mimeType = pickMimeType();
    if (!mimeType) {
      console.error("[media] no supported mimeType for MediaRecorder");
      statusEl.textContent = "Браузер не поддерживает запись";
      return;
    }

    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 500_000, // 500kbps — разумно для рации
    });

    recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0 && pttState === "talking") {
        try {
          const buf = await e.data.arrayBuffer();
          wsSend(MSG.MEDIA_CHUNK, buf);
        } catch (err) {
          console.error("[media] chunk read error:", err);
        }
      }
    };

    recorder.onerror = (e) => {
      console.error("[media] recorder error:", e.error);
    };

    recorder.start(200); // чанк каждые 200мс
    console.log("[media] recording started, mimeType:", mimeType);
  } catch (err) {
    // getUserMedia не дали — отпускаем эфир
    pttState = "idle";
    pttBtn.classList.remove("talking");
    wsSend(MSG.PTT_OFF);
  }
}

function stopTalking() {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
    console.log("[media] recording stopped");
  }
  recorder = null;
}

// ── MSE: воспроизведение входящих чанков ──

const MSE_MIME_CANDIDATES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMSEMimeType() {
  for (const mime of MSE_MIME_CANDIDATES) {
    if (MediaSource.isTypeSupported(mime)) return mime;
  }
  return "";
}

function initMSE() {
  teardownMSE();

  mediaSource = new MediaSource();
  remoteVideo.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener("sourceopen", () => {
    const mime = pickMSEMimeType();
    if (!mime) {
      console.error("[mse] no supported mimeType");
      return;
    }

    try {
      sourceBuffer = mediaSource.addSourceBuffer(mime);
    } catch (e) {
      console.error("[mse] addSourceBuffer error:", e);
      return;
    }

    sourceBuffer.mode = "sequence";

    sourceBuffer.addEventListener("updateend", () => {
      flushQueue();
      trimBuffer();
    });

    sourceBuffer.addEventListener("error", (e) => {
      console.error("[mse] sourceBuffer error:", e);
    });

    mseReady = true;
    console.log("[mse] ready, mimeType:", mime);
    flushQueue();
  });

  mediaSource.addEventListener("sourceclose", () => {
    console.log("[mse] source closed");
    mseReady = false;
  });
}

function teardownMSE() {
  mseReady = false;
  chunkQueue = [];

  if (sourceBuffer) {
    try {
      sourceBuffer.abort();
    } catch (e) {
      // ignore if not open
    }
    sourceBuffer = null;
  }

  if (mediaSource) {
    if (mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch (e) {
        // ignore
      }
    }
    // Revoke object URL
    if (remoteVideo.src) {
      URL.revokeObjectURL(remoteVideo.src);
    }
    mediaSource = null;
  }

  remoteVideo.removeAttribute("src");
  remoteVideo.load();
}

function flushQueue() {
  if (
    !mseReady ||
    !sourceBuffer ||
    sourceBuffer.updating ||
    chunkQueue.length === 0
  ) {
    return;
  }

  const chunk = chunkQueue.shift();
  try {
    sourceBuffer.appendBuffer(chunk);
  } catch (e) {
    console.error("[mse] appendBuffer error:", e);
    // При ошибке квоты — чистим буфер и пробуем снова
    if (e.name === "QuotaExceededError") {
      trimBuffer(true);
      chunkQueue.unshift(chunk);
    }
  }
}

// Удаляем старые данные из буфера чтобы не переполнить
function trimBuffer(force) {
  if (!sourceBuffer || sourceBuffer.updating) return;

  try {
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) return;

    const end = buffered.end(buffered.length - 1);
    const start = buffered.start(0);

    // Держим максимум 5 секунд буфера (или 2 при force)
    const maxDuration = force ? 2 : 5;
    if (end - start > maxDuration) {
      sourceBuffer.remove(start, end - maxDuration);
    }
  } catch (e) {
    // ignore
  }
}

function onRelayChunk(payload) {
  if (!mediaSource) {
    // Первый чанк нового стрима — инициализируем MSE
    noStreamEl.hidden = true;
    talkerLabel.hidden = false;
    initMSE();
  }

  chunkQueue.push(payload.buffer);
  flushQueue();

  // Попытка воспроизведения
  if (remoteVideo.paused) {
    remoteVideo.play().catch(() => {
      // Autoplay заблокирован — ставим muted и пробуем снова
      remoteVideo.muted = true;
      remoteVideo.play().catch((e) => {
        console.error("[mse] play error:", e);
      });
    });
  }
}

// ── Peer info заглушка (будет реализована на шаге 10) ──
function onPeerInfo(payload) {
  // TODO: шаг 10
}

// ── Утилита: отправка бинарного сообщения ──
function wsSend(type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (payload && payload.byteLength > 0) {
    const msg = new Uint8Array(1 + payload.byteLength);
    msg[0] = type;
    msg.set(new Uint8Array(payload), 1);
    ws.send(msg.buffer);
  } else {
    ws.send(new Uint8Array([type]).buffer);
  }
}
