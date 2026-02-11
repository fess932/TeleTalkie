package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io/fs"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"teletalkie/internal/room"
)

// Бинарный протокол: первый байт = тип сообщения.
const (
	// Client → Server
	MsgPTTOn      byte = 0x01 // запрос эфира
	MsgPTTOff     byte = 0x02 // освобождение эфира
	MsgMediaChunk byte = 0x03 // медиа-чанк от talker'а

	// Server → Client
	MsgPTTGranted  byte = 0x10 // эфир захвачен
	MsgPTTDenied   byte = 0x11 // эфир занят
	MsgPTTReleased byte = 0x12 // эфир освободился
	MsgRelayChunk  byte = 0x13 // медиа-чанк для listener'а
	MsgPeerInfo    byte = 0x14 // JSON: список участников
)

// peerInfoPayload — JSON-структура для PEER_INFO сообщения.
type peerInfoPayload struct {
	Peers  []string `json:"peers"`
	Talker string   `json:"talker"`
}

// Server — HTTP + WebSocket сервер TeleTalkie.
type Server struct {
	hub  *room.Hub
	mux  *http.ServeMux
	addr string
}

// New создаёт новый сервер.
func New(addr string, webFS fs.FS, hub *room.Hub) *Server {
	s := &Server{
		hub:  hub,
		mux:  http.NewServeMux(),
		addr: addr,
	}

	// Специальные обработчики для PWA файлов с правильными MIME-типами
	s.mux.HandleFunc("/manifest.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/manifest+json")
		http.ServeFileFS(w, r, webFS, "manifest.json")
	})
	s.mux.HandleFunc("/sw.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Service-Worker-Allowed", "/")
		http.ServeFileFS(w, r, webFS, "sw.js")
	})

	s.mux.Handle("/", http.FileServer(http.FS(webFS)))
	s.mux.HandleFunc("/ws", s.handleWS)

	return s
}

// ListenAndServe запускает HTTP-сервер.
func (s *Server) ListenAndServe() error {
	log.Printf("server: listening on %s (http)", s.addr)
	return http.ListenAndServe(s.addr, s.mux)
}

// ListenAndServeTLS запускает HTTPS-сервер с переданным TLS-сертификатом.
func (s *Server) ListenAndServeTLS(cert tls.Certificate) error {
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
	}

	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}

	tlsLn := tls.NewListener(ln, tlsCfg)
	log.Printf("server: listening on %s (https)", s.addr)
	return http.Serve(tlsLn, s.mux)
}

// handleWS — WebSocket upgrade и обслуживание клиента.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	name := r.URL.Query().Get("name")

	if roomID == "" || name == "" {
		http.Error(w, "missing room or name query param", http.StatusBadRequest)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Разрешаем любой origin для разработки.
		InsecureSkipVerify: true,
		// Увеличиваем лимит для видео-чанков (по умолчанию 32KB).
		// Типичный размер чанка: 50-500KB для видео.
		CompressionMode: websocket.CompressionDisabled, // отключаем сжатие для бинарных данных
	})
	// Устанавливаем лимит чтения после Accept
	conn.SetReadLimit(2 * 1024 * 1024) // 2MB
	if err != nil {
		log.Printf("server: websocket accept error: %v", err)
		return
	}

	peer := s.hub.Join(roomID, name)

	// Контекст отменяется при закрытии соединения.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Запускаем write-loop в отдельной горутине.
	go s.writeLoop(ctx, conn, peer)

	// Оповещаем всех в комнате о новом участнике.
	s.broadcastPeerInfo(peer.Room)

	// Read-loop блокирует текущую горутину.
	s.readLoop(ctx, conn, peer)

	// Клиент отключился — убираем из комнаты.
	s.hub.Leave(peer)
	conn.CloseNow()

	// Оповещаем оставшихся участников.
	s.broadcastPeerInfo(peer.Room)
}

// readLoop читает сообщения из WebSocket, парсит тип и обрабатывает.
func (s *Server) readLoop(ctx context.Context, conn *websocket.Conn, peer *room.Peer) {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			// Проверяем является ли это нормальным закрытием
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure ||
				websocket.CloseStatus(err) == websocket.StatusGoingAway ||
				websocket.CloseStatus(err) == websocket.StatusNoStatusRcvd {
				log.Printf("server: client %q disconnected gracefully (status: %v)", peer.Name, websocket.CloseStatus(err))
			} else {
				log.Printf("server: read error for %q: %v", peer.Name, err)
			}
			return
		}

		// Ожидаем только бинарные сообщения.
		if typ != websocket.MessageBinary {
			log.Printf("server: ignoring non-binary message from %q", peer.Name)
			continue
		}

		if len(data) == 0 {
			continue
		}

		msgType := data[0]
		payload := data[1:]

		switch msgType {
		case MsgPTTOn:
			s.handlePTTOn(ctx, conn, peer)

		case MsgPTTOff:
			s.handlePTTOff(peer)

		case MsgMediaChunk:
			s.handleMediaChunk(peer, payload)

		default:
			log.Printf("server: unknown message type 0x%02x from %q", msgType, peer.Name)
		}
	}
}

// writeLoop читает из канала peer.Send и пишет в WebSocket.
// Также отправляет ping каждые 30 секунд для поддержания соединения.
func (s *Server) writeLoop(ctx context.Context, conn *websocket.Conn, peer *room.Peer) {
	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-pingTicker.C:
			// Отправляем ping для keepalive
			pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				log.Printf("server: ping error for %q: %v", peer.Name, err)
				return
			}
		case msg, ok := <-peer.Send:
			if !ok {
				// Канал закрыт — peer покинул комнату.
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Write(writeCtx, websocket.MessageBinary, msg)
			cancel()
			if err != nil {
				log.Printf("server: write error for %q: %v", peer.Name, err)
				return
			}
		}
	}
}

// handlePTTOn — peer запрашивает эфир.
func (s *Server) handlePTTOn(ctx context.Context, conn *websocket.Conn, peer *room.Peer) {
	if peer.Room.TryAcquire(peer) {
		// Эфир захвачен — подтверждаем talker'у.
		writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		conn.Write(writeCtx, websocket.MessageBinary, []byte{MsgPTTGranted})
		cancel()
		// Оповещаем всех кто сейчас говорит.
		s.broadcastPeerInfo(peer.Room)
	} else {
		// Эфир занят — отказ.
		writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		conn.Write(writeCtx, websocket.MessageBinary, []byte{MsgPTTDenied})
		cancel()
	}
}

// handlePTTOff — peer освобождает эфир.
func (s *Server) handlePTTOff(peer *room.Peer) {
	peer.Room.Release(peer)
	// Оповещаем всех остальных что эфир свободен.
	peer.Room.Broadcast(peer, []byte{MsgPTTReleased})
	// Обновляем список участников (talker сброшен).
	s.broadcastPeerInfo(peer.Room)
}

// handleMediaChunk — relay медиа-чанка от talker'а ко всем.
func (s *Server) handleMediaChunk(peer *room.Peer, payload []byte) {
	// Только текущий talker может слать чанки.
	if peer.Room.Talker != peer {
		return
	}
	// Оборачиваем в серверный тип и рассылаем.
	msg := make([]byte, 1+len(payload))
	msg[0] = MsgRelayChunk
	copy(msg[1:], payload)
	peer.Room.Broadcast(peer, msg)
}

// broadcastPeerInfo рассылает PEER_INFO всем участникам комнаты.
func (s *Server) broadcastPeerInfo(r *room.Room) {
	peers := r.Peers()

	names := make([]string, 0, len(peers))
	for _, p := range peers {
		names = append(names, p.Name)
	}

	talkerName := ""
	if r.Talker != nil {
		talkerName = r.Talker.Name
	}

	info := peerInfoPayload{
		Peers:  names,
		Talker: talkerName,
	}

	jsonData, err := json.Marshal(info)
	if err != nil {
		log.Printf("server: marshal peer info error: %v", err)
		return
	}

	msg := make([]byte, 1+len(jsonData))
	msg[0] = MsgPeerInfo
	copy(msg[1:], jsonData)

	// Рассылаем всем (sender=nil — получат все).
	r.Broadcast(nil, msg)
}
