// TeleTalkie — app.js

// ── Мобильная отладка (eruda) — активируется через ?debug в URL ──
if (location.search.includes("debug")) {
  const script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/eruda";
  script.onload = () => {
    window.eruda.init();
    console.log("[debug] eruda console loaded");
  };
  document.head.appendChild(script);
}

// ── Service Worker регистрация ──
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => console.log("[SW] Registered:", reg.scope))
    .catch((err) => console.error("[SW] Registration failed:", err));
}

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
const leaveBtn = document.getElementById("leave-btn");
const pttBtn = document.getElementById("ptt-btn");
// const statusEl = document.getElementById("status"); // removed from UI
const remoteVideo = document.getElementById("remote-video");
const localVideo = document.getElementById("local-video");
const talkerLabel = document.getElementById("talker-label");
const talkerNameEl = document.getElementById("talker-name");
const noStreamEl = document.getElementById("no-stream");
const peersList = document.getElementById("peers-list");
const unmuteBtn = document.getElementById("unmute-btn");
const rotateBtn = document.getElementById("rotate-btn");
const refreshBtn = document.getElementById("refresh-btn");
const refreshBtnLogin = document.getElementById("refresh-btn-login");

// ── PTT звуки рации (WAV файлы) ──
const pttStartSound = new Audio("/start.wav");
const pttStopSound = new Audio("/stop.wav");

// Предзагрузка звуков для минимальной задержки
pttStartSound.load();
pttStopSound.load();

function playPTTOn() {
  try {
    pttStartSound.currentTime = 0;
    pttStartSound
      .play()
      .catch((e) => console.warn("[audio] start play failed:", e));
  } catch (e) {
    console.warn("[audio] ptt-on sound failed:", e);
  }
}

function playPTTOff() {
  try {
    pttStopSound.currentTime = 0;
    pttStopSound
      .play()
      .catch((e) => console.warn("[audio] stop play failed:", e));
  } catch (e) {
    console.warn("[audio] ptt-off sound failed:", e);
  }
}

// ── Состояние ──
let ws = null;
let localStream = null; // кэшированный MediaStream (камера+микрофон)
let canvasStream = null; // stream с canvas для отправки
let canvasElements = null; // { canvas, tempVideo } для cleanup
let recorder = null; // MediaRecorder
let recorderInitialized = false; // флаг что recorder создан с правильным stream
let pttState = "idle"; // idle | requesting | talking
let pttMode = "hold"; // hold | toggle
let currentRoom = "";
let currentName = "";
let reconnectTimer = null;
let currentTalker = ""; // имя текущего talker'а (из PEER_INFO)
let canvasAnimationId = null; // requestAnimationFrame ID для canvas рендеринга

// ── MSE состояние ──
let mediaSource = null;
let sourceBuffer = null;
let chunkQueue = [];
let mseReady = false;

// ── Выбор mimeType для MediaRecorder (только H.264 + AAC) ──
const H264_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2", // H.264 Baseline + AAC
  "video/mp4;codecs=avc1.4d002a,mp4a.40.2", // H.264 Main + AAC
  "video/mp4;codecs=avc1.42E01E", // H.264 Baseline без аудио
  "video/mp4", // Общий MP4
];

function pickRecorderMimeType() {
  console.log("[media] detecting H.264 MediaRecorder codec support...");
  console.log("[media] platform:", navigator.platform);
  console.log("[media] userAgent:", navigator.userAgent);

  for (const mime of H264_MIME_CANDIDATES) {
    const supported = MediaRecorder.isTypeSupported(mime);
    console.log(`[media] recorder: ${mime} = ${supported}`);

    if (supported) {
      console.log("[media] ✅ selected H.264 mimeType:", mime);
      return mime;
    }
  }

  console.error("[media] ❌ H.264 not supported in MediaRecorder!");
  return "";
}

// ── Выбор mimeType для MSE (приём только H.264 + AAC) ──
const MSE_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2", // H.264 Baseline + AAC
  "video/mp4;codecs=avc1.4d002a,mp4a.40.2", // H.264 Main + AAC
  "video/mp4;codecs=avc1.42E01E", // H.264 Baseline без аудио
  "video/mp4", // Общий MP4
];

function pickMSEMimeType() {
  console.log("[media] detecting MSE codec support...");

  for (const mime of MSE_MIME_CANDIDATES) {
    const supported = MediaSource.isTypeSupported(mime);
    console.log(`[media] mse: ${mime} = ${supported}`);

    if (supported) {
      console.log("[media] ✅ selected MSE mimeType:", mime);
      return mime;
    }
  }

  console.error("[media] ❌ no supported mimeType for MSE!");
  return "";
}

// ── Экран входа ──

// Загружаем сохраненные данные при загрузке страницы
window.addEventListener("DOMContentLoaded", () => {
  const savedName = localStorage.getItem("teletalkie_name");
  const savedRoom = localStorage.getItem("teletalkie_room");

  if (savedName) {
    nameInput.value = savedName;
  }
  if (savedRoom) {
    roomInput.value = savedRoom;
  }

  // Автоматически подключаемся если есть и имя и комната
  if (savedName && savedRoom) {
    console.log("[app] auto-joining last room:", savedRoom);
    handleJoin();
  }
});

joinBtn.addEventListener("click", handleJoin);

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") roomInput.focus();
});
roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleJoin();
});

leaveBtn.addEventListener("click", () => {
  if (confirm("Выйти из комнаты?")) {
    leaveRoom();
  }
});

// Refresh buttons
refreshBtn.addEventListener("click", () => location.reload());
refreshBtnLogin.addEventListener("click", () => location.reload());

// Rotate video button
let videoRotation = 0; // 0, 90, 180, 270
rotateBtn.addEventListener("click", () => {
  videoRotation = (videoRotation + 90) % 360;

  // Убираем все классы поворота
  remoteVideo.classList.remove("rotate-90", "rotate-180", "rotate-270");

  // Добавляем нужный класс
  if (videoRotation === 90) {
    remoteVideo.classList.add("rotate-90");
  } else if (videoRotation === 180) {
    remoteVideo.classList.add("rotate-180");
  } else if (videoRotation === 270) {
    remoteVideo.classList.add("rotate-270");
  }

  console.log("[video] rotated to", videoRotation, "degrees");
});

// Unmute / Play button — handles both unmuting and starting playback on iOS
unmuteBtn.addEventListener("click", () => {
  remoteVideo.muted = false;
  remoteVideo
    .play()
    .then(() => {
      console.log("[ui] play+unmute successful");
      unmuteBtn.hidden = true;
    })
    .catch((err) => {
      console.warn("[ui] play after tap failed:", err.name);
      // Если даже после тапа не играет со звуком — пробуем muted
      remoteVideo.muted = true;
      remoteVideo
        .play()
        .then(() => {
          unmuteBtn.textContent = "🔇 Включить звук";
        })
        .catch((e) => {
          console.error("[ui] play failed even after user tap:", e.name);
        });
    });
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

  // Сохраняем в localStorage
  localStorage.setItem("teletalkie_name", name);
  localStorage.setItem("teletalkie_room", room);

  currentRoom = room;
  currentName = name;
  connect(room, name);
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}

function hideLoginError() {
  loginError.hidden = true;
}

function leaveRoom() {
  // Закрываем WebSocket соединение
  if (ws) {
    ws.close();
    ws = null;
  }

  // Останавливаем запись и воспроизведение
  stopTalking();
  teardownMSE();
  releaseLocalStream();

  // Очищаем состояние
  pttState = "idle";
  currentRoom = "";
  currentName = "";
  currentTalker = "";
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Возвращаемся на экран входа
  roomScreen.hidden = true;
  loginScreen.hidden = false;
  joinBtn.disabled = false;
  joinBtn.textContent = "Войти";

  console.log("[app] left room");
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
    // Если мы на экране входа — показать ошибку
    if (!loginScreen.hidden) {
      joinBtn.disabled = false;
      joinBtn.textContent = "Войти";
      showLoginError("Не удалось подключиться");
    }
    // Если мы в комнате — handleDisconnect (из close) сделает reconnect
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
  console.log("[room] connected");
}

function handleDisconnect() {
  stopTalking();
  teardownMSE();
  pttState = "idle";

  if (!loginScreen.hidden) return; // ещё на экране входа

  console.log("[ws] disconnected, will reconnect...");
  pttBtn.disabled = true;

  // Автоматический реконнект
  if (currentRoom && currentName) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (roomScreen.hidden) return; // уже вышли на экран входа
    console.log("[ws] reconnecting...");
    connect(currentRoom, currentName);
  }, 2000);
}

// ── PTT кнопка (mouse + touch) ──

function pttDown() {
  if (pttState !== "idle") return;
  pttState = "requesting";
  pttBtn.classList.add("talking");
  console.log("[ptt] requesting...");
  playPTTOn();
  wsSend(MSG.PTT_ON);
}

function pttUp() {
  if (pttState === "talking") {
    playPTTOff();
    stopTalking();
    wsSend(MSG.PTT_OFF);
    pttState = "idle";
    pttBtn.classList.remove("talking");
    console.log("[ptt] released");
  } else if (pttState === "requesting") {
    // Отпустили до получения ответа — всё равно шлём OFF
    playPTTOff();
    wsSend(MSG.PTT_OFF);
    pttState = "idle";
    pttBtn.classList.remove("talking");
    console.log("[ptt] cancelled");
  }
}

function pttToggle() {
  if (pttState === "idle") {
    pttDown();
  } else {
    pttUp();
  }
}

// PTT mode toggle button
const modeBtn = document.getElementById("mode-btn");
modeBtn.addEventListener("click", () => {
  // Переключаем режим
  if (pttMode === "hold") {
    pttMode = "toggle";
    modeBtn.dataset.mode = "toggle";
    modeBtn.textContent = "⏯";
    modeBtn.title = "Переключение";
  } else {
    pttMode = "hold";
    modeBtn.dataset.mode = "hold";
    modeBtn.textContent = "⏺";
    modeBtn.title = "Удержание";
  }

  console.log("[ptt] mode changed to:", pttMode);

  // Если переключили режим пока говорим — отпускаем
  if (pttState !== "idle") {
    pttUp();
  }
});

// Mouse events
pttBtn.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // только левая кнопка
  e.preventDefault();
  if (pttMode === "hold") {
    pttDown();
  }
});

pttBtn.addEventListener("click", (e) => {
  if (pttMode === "toggle") {
    pttToggle();
  }
});

document.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  if (pttMode === "hold") {
    pttUp();
  }
});

// Touch events
pttBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (pttMode === "hold") {
    pttDown();
  }
});

pttBtn.addEventListener("touchend", (e) => {
  if (pttMode === "toggle") {
    pttToggle();
  }
});

document.addEventListener("touchend", (e) => {
  if (pttMode === "hold") {
    pttUp();
  }
});

document.addEventListener("touchcancel", (e) => {
  if (pttMode === "hold") {
    pttUp();
  }
});

// Keyboard: пробел как PTT (когда фокус не на инпутах)
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && roomScreen && !roomScreen.hidden) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    if (pttMode === "hold") {
      if (!e.repeat) pttDown();
    } else {
      // В toggle режиме пробел работает как click
      if (!e.repeat) pttToggle();
    }
  }
});

document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && roomScreen && !roomScreen.hidden) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    if (pttMode === "hold") {
      pttUp();
    }
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
  console.log("[ptt] now talking");
  startTalking();
}

function onPTTDenied() {
  console.log("[ptt] denied - channel busy");
  pttState = "idle";
  pttBtn.classList.remove("talking");
}

function onPTTReleased() {
  console.log("[ptt] channel released");
  currentTalker = "";
  talkerLabel.hidden = true;
  noStreamEl.hidden = false;
  teardownMSE();
}

// ── Canvas для захвата и отправки видео ──

function createCanvasStream(videoStream) {
  const videoTrack = videoStream.getVideoTracks()[0];
  const settings = videoTrack.getSettings();

  // Создаём canvas с размерами видео
  const canvas = document.createElement("canvas");
  canvas.width = settings.width || 640;
  canvas.height = settings.height || 480;
  const ctx = canvas.getContext("2d");

  // Создаём временный video элемент для рендеринга
  const tempVideo = document.createElement("video");
  tempVideo.srcObject = videoStream;
  tempVideo.play();

  // Рендерим каждый кадр на canvas
  function renderFrame() {
    if (tempVideo.readyState >= tempVideo.HAVE_CURRENT_DATA) {
      ctx.drawImage(tempVideo, 0, 0, canvas.width, canvas.height);
    }
    canvasAnimationId = requestAnimationFrame(renderFrame);
  }

  renderFrame();

  // Захватываем stream с canvas (15 fps для экономии ресурсов)
  const stream = canvas.captureStream(15);

  // Добавляем аудио из оригинального потока
  const audioTrack = videoStream.getAudioTracks()[0];
  if (audioTrack) {
    stream.addTrack(audioTrack);
  }

  return { stream, canvas, tempVideo, renderFrame };
}

function stopCanvasStream() {
  if (canvasAnimationId) {
    cancelAnimationFrame(canvasAnimationId);
    canvasAnimationId = null;
  }
}

// ── MediaRecorder: захват и отправка чанков ──

async function ensureLocalStream() {
  if (localStream) return localStream;

  try {
    console.log("[media] requesting camera/mic access...");
    // Определяем является ли устройство iOS/iPad
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 15, max: 30 },
        facingMode: isIOS ? "user" : undefined, // На iOS используем фронтальную камеру
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    console.log("[media] ✅ got local stream");
    console.log("[media] video tracks:", localStream.getVideoTracks().length);
    console.log("[media] audio tracks:", localStream.getAudioTracks().length);
    return localStream;
  } catch (err) {
    console.error("[media] ❌ getUserMedia failed:", err.name, err.message);
    alert("Нет доступа к камере/микрофону: " + err.message);
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
    // Убеждаемся что предыдущий recorder остановлен
    if (recorder) {
      console.warn("[media] recorder still exists, stopping it");
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      recorder = null;
    }

    // Убеждаемся что предыдущий canvas stream остановлен
    if (canvasStream) {
      console.warn("[media] canvas stream still exists, stopping it");
      stopCanvasStream();
      canvasStream.getTracks().forEach((t) => t.stop());
      canvasStream = null;
    }

    const stream = await ensureLocalStream();

    // Показываем локальное превью (оригинальный stream)
    localVideo.srcObject = stream;
    localVideo.hidden = false;
    remoteVideo.hidden = true;
    noStreamEl.hidden = true;

    // ВРЕМЕННО: отправляем оригинальный stream БЕЗ canvas для тестирования
    // const { stream: canvasStreamObj } = createCanvasStream(stream);
    // canvasStream = canvasStreamObj;
    // console.log("[media] canvas stream created, tracks:", canvasStream.getTracks().length);

    const mimeType = pickRecorderMimeType();
    if (!mimeType) {
      console.error("[media] ❌ no supported mimeType for MediaRecorder");
      alert(
        "Ваш браузер не поддерживает запись видео. Попробуйте обновить iOS или использовать другой браузер.",
      );
      pttState = "idle";
      pttBtn.classList.remove("talking");
      wsSend(MSG.PTT_OFF);
      // stopCanvasStream();
      return;
    }

    console.log("[media] creating MediaRecorder with:", mimeType);

    try {
      // ВРЕМЕННО: записываем оригинальный stream для тестирования
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 400_000, // 400kbps для меньших чанков
      });
    } catch (err) {
      console.error(
        "[media] ❌ MediaRecorder creation failed:",
        err.name,
        err.message,
      );
      alert("MediaRecorder не поддерживается: " + err.message);
      pttState = "idle";
      pttBtn.classList.remove("talking");
      wsSend(MSG.PTT_OFF);
      stopCanvasStream();
      return;
    }

    recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0 && pttState === "talking") {
        try {
          const buf = await e.data.arrayBuffer();
          console.log("[media] sending chunk, size:", buf.byteLength);
          wsSend(MSG.MEDIA_CHUNK, buf);
        } catch (err) {
          console.error("[media] chunk read error:", err);
        }
      }
    };

    recorder.onerror = (e) => {
      console.error("[media] recorder error:", e.error);
    };

    recorder.onstart = () => {
      console.log("[media] recording started, mimeType:", mimeType);
      console.log("[media] recorder state:", recorder.state);
      console.log("[media] canvas stream active:", canvasStream.active);
      console.log(
        "[media] canvas video track:",
        canvasStream.getVideoTracks()[0]?.readyState,
      );
      console.log(
        "[media] canvas audio track:",
        canvasStream.getAudioTracks()[0]?.readyState,
      );
    };

    recorder.onstop = () => {
      console.log("[media] recording stopped");
    };

    // Запускаем с интервалом 200мс для стабильных чанков ~10KB
    console.log("[media] starting recorder...");
    recorder.start(200); // чанк каждые 200мс
  } catch (err) {
    console.error("[media] startTalking error:", err);
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

  // Останавливаем canvas stream
  stopCanvasStream();
  if (canvasStream) {
    canvasStream.getTracks().forEach((t) => t.stop());
    canvasStream = null;
  }

  // Скрываем локальное превью
  localVideo.hidden = true;
  localVideo.srcObject = null;
  remoteVideo.hidden = false;

  // Показываем "Эфир свободен" если никого нет в эфире
  if (!currentTalker) {
    noStreamEl.hidden = false;
  }
}

// ── MSE: воспроизведение входящих чанков ──

function initMSE() {
  teardownMSE();

  mediaSource = new MediaSource();
  remoteVideo.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener("sourceopen", () => {
    // Используем функцию выбора MIME-типа для MSE
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

      // Если видео в состоянии waiting и есть буферизованные данные, пробуем продолжить
      if (
        sourceBuffer &&
        remoteVideo.readyState < remoteVideo.HAVE_FUTURE_DATA &&
        sourceBuffer.buffered.length > 0
      ) {
        const bufferedEnd = sourceBuffer.buffered.end(
          sourceBuffer.buffered.length - 1,
        );
        const currentTime = remoteVideo.currentTime;
        if (bufferedEnd > currentTime + 0.1) {
          console.log(
            "[mse] have buffered data, attempting to resume playback",
          );
          remoteVideo
            .play()
            .catch((e) => console.warn("[mse] resume play failed:", e));
        }
      }
    });

    sourceBuffer.addEventListener("error", (e) => {
      console.error("[mse] sourceBuffer error:", e);
      // При ошибке полностью пересоздаём MSE (отложенно, чтобы выйти из callback)
      setTimeout(() => teardownMSE(), 0);
    });

    mseReady = true;
    console.log("[mse] ready, mimeType:", mime);
    flushQueue();
  });

  mediaSource.addEventListener("sourceclose", () => {
    console.log("[mse] source closed");
    mseReady = false;
  });

  mediaSource.addEventListener("error", (e) => {
    console.error("[mse] MediaSource error:", e);
    // При ошибке полностью пересоздаём MSE (отложенно, чтобы выйти из callback)
    setTimeout(() => teardownMSE(), 0);
  });

  // Обработка событий video элемента
  remoteVideo.addEventListener("waiting", () => {
    console.log(
      "[mse] video waiting for data, currentTime:",
      remoteVideo.currentTime,
    );
  });

  remoteVideo.addEventListener("playing", () => {
    console.log("[mse] video playing");
  });

  remoteVideo.addEventListener("stalled", () => {
    console.log("[mse] video stalled");
  });

  remoteVideo.addEventListener("error", (e) => {
    console.error("[mse] video error:", remoteVideo.error);
  });
}

function teardownMSE() {
  console.log("[mse] tearing down MSE");
  mseReady = false;
  chunkQueue = [];

  if (sourceBuffer) {
    try {
      // Удаляем все event listeners
      sourceBuffer.onupdateend = null;
      sourceBuffer.onerror = null;

      // Пробуем abort только если mediaSource открыт
      if (mediaSource && mediaSource.readyState === "open") {
        sourceBuffer.abort();
      }
    } catch (e) {
      console.warn("[mse] sourceBuffer cleanup error:", e);
    }
    sourceBuffer = null;
  }

  if (mediaSource) {
    try {
      // Удаляем все sourceBuffers
      if (mediaSource.readyState === "open") {
        // Не вызываем endOfStream - это может вызвать ошибки
        // Просто закрываем
      }
    } catch (e) {
      console.warn("[mse] mediaSource cleanup error:", e);
    }

    // Удаляем event listeners
    mediaSource.onsourceopen = null;
    mediaSource.onsourceclose = null;
    mediaSource.onerror = null;

    // Revoke object URL
    if (remoteVideo.src) {
      URL.revokeObjectURL(remoteVideo.src);
    }
    mediaSource = null;
  }

  // Полностью очищаем video element
  remoteVideo.removeAttribute("src");
  remoteVideo.srcObject = null;
  remoteVideo.load();

  console.log("[mse] teardown complete");
}

function flushQueue() {
  if (!mseReady) {
    console.log("[mse] flushQueue: MSE not ready");
    return;
  }
  if (!sourceBuffer) {
    console.log("[mse] flushQueue: no sourceBuffer");
    return;
  }
  if (sourceBuffer.updating) {
    return;
  }
  if (chunkQueue.length === 0) {
    return;
  }

  const chunk = chunkQueue.shift();
  console.log(
    "[mse] appending chunk, size:",
    chunk.byteLength,
    "queue:",
    chunkQueue.length,
  );
  try {
    sourceBuffer.appendBuffer(chunk);
  } catch (e) {
    console.error("[mse] appendBuffer error:", e.name, e.message);
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
    const currentTime = remoteVideo.currentTime;

    // Держим максимум 2 секунд буфера для минимальной задержки (или 1 при force)
    const maxDuration = force ? 1 : 2;
    if (end - start > maxDuration) {
      // Удаляем данные ДО текущей позиции воспроизведения минус 1 сек
      const removeEnd = Math.max(start, currentTime - 1);
      if (removeEnd > start) {
        console.log("[mse] trimming buffer from", start, "to", removeEnd);
        sourceBuffer.remove(start, removeEnd);
      }
    }
  } catch (e) {
    console.warn("[mse] trimBuffer error:", e);
  }
}

function onRelayChunk(payload) {
  // Если MSE не готов или был сброшен — пересоздаём
  if (!mediaSource || !mseReady) {
    // Первый чанк нового стрима — инициализируем MSE
    console.log("[mse] new stream, initializing MSE");
    noStreamEl.hidden = true;
    talkerLabel.hidden = false;

    // Полностью очищаем старый MSE если он был
    if (mediaSource) {
      teardownMSE();
    }

    initMSE();

    // Добавляем чанк в очередь и ждём пока MSE станет готов
    console.log(
      "[mse] queueing chunk until MSE ready, size:",
      payload.byteLength,
    );
    chunkQueue.push(payload.buffer);
    // flushQueue будет вызван автоматически в sourceopen event
    return;
  }

  console.log("[mse] received chunk, size:", payload.byteLength);
  chunkQueue.push(payload.buffer);
  flushQueue();

  // Попытка воспроизведения со звуком (только если MSE готов и есть данные)
  if (
    remoteVideo.paused &&
    mseReady &&
    sourceBuffer &&
    sourceBuffer.buffered.length > 0
  ) {
    // ВАЖНО: Сразу перематываем к live-краю перед воспроизведением
    const bufferedEnd = sourceBuffer.buffered.end(
      sourceBuffer.buffered.length - 1,
    );
    remoteVideo.currentTime = bufferedEnd - 0.1;
    console.log(
      "[mse] seeking to live edge before play:",
      bufferedEnd.toFixed(2),
    );

    console.log("[mse] attempting to play with audio...");
    remoteVideo.muted = false;
    remoteVideo
      .play()
      .then(() => {
        console.log("[mse] playing with audio successfully");
        unmuteBtn.hidden = true;
      })
      .catch((err) => {
        console.log(
          "[mse] autoplay with audio blocked:",
          err.name,
          "- trying muted",
        );
        // Autoplay со звуком заблокирован — пробуем без звука
        remoteVideo.muted = true;
        remoteVideo
          .play()
          .then(() => {
            console.log("[mse] playing muted, unmute button shown");
            unmuteBtn.textContent = "🔇 Включить звук";
            unmuteBtn.hidden = false;
          })
          .catch((e) => {
            console.error("[mse] play error even muted:", e.name, e.message);
            // Даже muted autoplay заблокирован (iPad/iOS) — показываем кнопку запуска
            unmuteBtn.textContent = "▶ Нажмите для воспроизведения";
            unmuteBtn.hidden = false;
          });
      });
  }

  // Синхронизация с live-краем: если отстаём больше чем на 0.2 сек, перематываем (более агрессивно)
  if (!remoteVideo.paused && sourceBuffer && sourceBuffer.buffered.length > 0) {
    const bufferedEnd = sourceBuffer.buffered.end(
      sourceBuffer.buffered.length - 1,
    );
    const lag = bufferedEnd - remoteVideo.currentTime;
    if (lag > 0.2) {
      console.log(
        "[mse] lag detected:",
        lag.toFixed(2),
        "s, seeking to live edge",
      );
      remoteVideo.currentTime = bufferedEnd - 0.05;
    }
  }
}

// ── Peer info: список участников и кто говорит ──
function onPeerInfo(payload) {
  try {
    const text = new TextDecoder().decode(payload);
    const info = JSON.parse(text);

    // Обновляем список участников
    peersList.innerHTML = "";
    if (info.peers && Array.isArray(info.peers)) {
      for (const name of info.peers) {
        const li = document.createElement("li");
        li.textContent = name;
        if (name === info.talker) {
          li.classList.add("is-talker");
        }
        if (name === currentName) {
          li.style.fontWeight = "bold";
        }
        peersList.appendChild(li);
      }
    }

    // Обновляем индикатор talker'а
    if (info.talker && info.talker !== currentName) {
      currentTalker = info.talker;
      talkerNameEl.textContent = info.talker;
      talkerLabel.hidden = false;
      noStreamEl.hidden = true;
    } else if (!info.talker) {
      currentTalker = "";
      talkerLabel.hidden = true;
      if (pttState !== "talking") {
        noStreamEl.hidden = false;
      }
    }
  } catch (e) {
    console.error("[peer_info] parse error:", e);
  }
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
