# TeleTalkie — пошаговый план разработки

Видеорация: приложение для общения. Push-to-talk, видеопоток через WebSocket чанками. DPI видит только WebSocket с бинарными фреймами.

## Архитектура

```
┌──────────┐    WebSocket (binary chunks)    ┌──────────────┐
│ Client A │ ──────────────────────────────▶ │              │
│ (talker) │   MediaRecorder → chunks        │   Go Server  │
│          │                                  │   (relay)    │
└──────────┘                                  │              │
                                              │  Room "abc"  │
┌──────────┐    WebSocket (binary chunks)    │              │
│ Client B │ ◀────────────────────────────── │              │
│(listener)│   chunks → MSE → <video>        │              │
└──────────┘                                  │              │
                                              │              │
┌──────────┐    WebSocket (binary chunks)    │              │
│ Client C │ ◀────────────────────────────── │              │
│(listener)│                                  └──────────────┘
└──────────┘
```

## Структура проекта

```
teletalkie/
├── cmd/
│   └── teletalkie/
│       └── main.go              # точка входа, флаги
├── internal/
│   ├── server/
│   │   └── server.go            # HTTP + WebSocket upgrade
│   └── room/
│       └── room.go              # комнаты, участники, relay, PTT-арбитраж
├── web/
│   ├── index.html
│   ├── app.js                   # MediaRecorder + MSE + WebSocket + UI
│   └── style.css
├── go.mod
├── go.sum
└── PLAN.md
```

## Протокол WebSocket (бинарный)

Первый байт — тип сообщения:

| Байт   | Направление | Тип           | Payload                          |
|--------|-------------|---------------|----------------------------------|
| `0x01` | C→S         | PTT_ON        | — (запрос эфира)                 |
| `0x02` | C→S         | PTT_OFF       | — (освобождение эфира)           |
| `0x03` | C→S         | MEDIA_CHUNK   | raw WebM chunk                   |
| `0x10` | S→C         | PTT_GRANTED   | — (эфир твой)                    |
| `0x11` | S→C         | PTT_DENIED    | — (эфир занят)                   |
| `0x12` | S→C         | PTT_RELEASED  | — (эфир освободился)             |
| `0x13` | S→C         | MEDIA_CHUNK   | raw WebM chunk                   |
| `0x14` | S→C         | PEER_INFO     | JSON: участники, кто говорит     |

## Зависимости

- `github.com/coder/websocket` — WebSocket
- Стандартная библиотека Go — всё остальное
- Никаких внешних зависимостей типа ffmpeg — кодирование на стороне браузера

---

## Шаги

### ~~Шаг 1: Scaffold проекта~~ ✅
- [x] Создать структуру папок
- [x] `go get github.com/coder/websocket`
- [x] Заглушка `main.go` — стартует HTTP на `:8080`, отдаёт "hello"
- **Проверка:** `go run ./cmd/teletalkie`, браузер → `localhost:8080` → видим "hello"

---

### ~~Шаг 2: Статика через embed~~ ✅
- [x] Создать `web/index.html` — минимальная страница с заголовком "TeleTalkie"
- [x] `web/app.js` — пустой
- [x] `web/style.css` — пустой
- [x] Встроить через `embed.FS`, отдавать по `/`
- **Проверка:** браузер → видим HTML-страницу

---

### ~~Шаг 3: Room + Peer (бэкенд)~~ ✅
- [x] `internal/room/room.go`
- [x] Структура `Peer` — имя, ws-соединение, канал для отправки
- [x] Структура `Room` — id, map peer'ов, кто сейчас talker, мьютекс
- [x] Структура `Hub` — map комнат, создание/удаление комнат
- [x] Методы: `Hub.Join(roomID, name, conn)`, `Hub.Leave(peer)`, `Room.Broadcast(sender, msg)`
- **Проверка:** `go build ./...` компилируется

---

### ~~Шаг 4: PTT-арбитраж (бэкенд)~~ ✅
- [x] `Room.TryAcquire(peer) bool` — захват эфира
- [x] `Room.Release(peer)` — освобождение
- [x] Только один talker одновременно
- **Проверка:** юнит-тест — два peer'а пробуют захватить, второй получает отказ

---

### ~~Шаг 5: WebSocket endpoint (бэкенд)~~ ✅
- [x] `internal/server/server.go`
- [x] `GET /ws?room=XXX&name=YYY` — upgrade через `coder/websocket`
- [x] При подключении: `hub.Join()`, запуск read-loop + write-loop для peer'а
- [x] Read-loop: парсит первый байт (тип), вызывает нужный метод Room
- [x] Write-loop: читает из канала peer'а, пишет в ws
- [x] При отключении: `hub.Leave()`
- [x] Бинарный протокол (первый байт = тип)
- **Проверка:** подключиться браузером, видим в логах "peer joined room X"

---

### ~~Шаг 6: Relay чанков (бэкенд)~~ ✅
- [x] `MEDIA_CHUNK (0x03)` от talker'а → проверить что peer = talker → обернуть в `0x13` → fan-out
- [x] `PTT_ON (0x01)` → `TryAcquire` → ответить `GRANTED/DENIED`
- [x] `PTT_OFF (0x02)` → `Release` → разослать `PTT_RELEASED` всем
- [x] Неблокирующая отправка (дропать если буфер peer'а полон)
- **Проверка:** два клиента, один шлёт байты — второй получает

---

### ~~Шаг 7: Фронтенд — экран входа~~ ✅
- [x] Поле "Имя", поле "Комната", кнопка "Войти"
- [x] По клику → `new WebSocket(ws://host/ws?room=X&name=Y)`
- [x] Показать экран комнаты (пока пустой)
- **Проверка:** ввести имя+комнату → ws подключается → в логах сервера видно

---

### ~~Шаг 8: Фронтенд — PTT + MediaRecorder (захват)~~ ✅
- [x] Кнопка PTT (mousedown/mouseup + touch)
- [x] При нажатии: отправить `0x01`, дождаться `0x10`, getUserMedia, MediaRecorder
- [x] `recorder.start(200)` — чанк каждые 200мс
- [x] `ondataavailable` → `ws.send(0x03 + chunk)`
- [x] При отпускании: `recorder.stop()`, отправить `0x02`
- **Проверка:** нажать PTT → в Network видны бинарные WS-фреймы

---

### ~~Шаг 9: Фронтенд — MSE (воспроизведение)~~ ✅
- [x] `<video>` + `MediaSource` + `SourceBuffer('video/webm;codecs=vp8,opus')`
- [x] При получении `0x13` → `sourceBuffer.appendBuffer(payload)`
- [x] Очередь если `updating === true`
- [x] При `0x12` (PTT_RELEASED) → очистка буфера для следующего talker'а
- **Проверка:** две вкладки — одна PTT, вторая видит видео+звук

---

### ~~Шаг 10: Фронтенд — UI и полировка~~ ✅
- [x] Индикатор: кто говорит (по `PEER_INFO`)
- [x] Список участников
- [x] Визуальная обратная связь PTT (кнопка горит)
- [x] Обработка ошибок (камера, ws reconnect)
- [x] Мобильная адаптация (touch events)
- **Проверка:** полноценный тест с двух устройств