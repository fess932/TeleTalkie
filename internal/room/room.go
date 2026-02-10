package room

import (
	"log"
	"sync"
)

// Peer — участник комнаты.
type Peer struct {
	Name string
	Room *Room
	Send chan []byte // буфер исходящих сообщений, читается write-loop'ом в server
}

// Room — комната с участниками и PTT-состоянием.
type Room struct {
	ID     string
	Talker *Peer // кто сейчас держит эфир (nil = свободен)

	mu    sync.Mutex
	peers map[*Peer]struct{}
}

// Peers возвращает копию списка участников (потокобезопасно).
func (r *Room) Peers() []*Peer {
	r.mu.Lock()
	defer r.mu.Unlock()

	out := make([]*Peer, 0, len(r.peers))
	for p := range r.peers {
		out = append(out, p)
	}
	return out
}

// PeerCount возвращает количество участников.
func (r *Room) PeerCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.peers)
}

// Broadcast отправляет сообщение всем участникам комнаты, кроме sender.
// Если канал peer'а полон — чанк дропается (неблокирующая отправка).
func (r *Room) Broadcast(sender *Peer, msg []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for p := range r.peers {
		if p == sender {
			continue
		}
		select {
		case p.Send <- msg:
		default:
			log.Printf("room %s: dropping message for peer %q (buffer full)", r.ID, p.Name)
		}
	}
}

// TryAcquire пытается захватить эфир для peer'а.
// Возвращает true если эфир свободен и успешно захвачен, false если занят.
func (r *Room) TryAcquire(p *Peer) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.Talker != nil {
		return false
	}
	r.Talker = p
	log.Printf("room %s: %q acquired PTT", r.ID, p.Name)
	return true
}

// Release освобождает эфир. Если peer не является текущим talker'ом — ничего не делает.
func (r *Room) Release(p *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.Talker != p {
		return
	}
	r.Talker = nil
	log.Printf("room %s: %q released PTT", r.ID, p.Name)
}

func (r *Room) addPeer(p *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.peers[p] = struct{}{}
}

func (r *Room) removePeer(p *Peer) (empty bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.peers, p)
	if r.Talker == p {
		r.Talker = nil
	}
	return len(r.peers) == 0
}

// Hub управляет всеми комнатами.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room
}

// NewHub создаёт новый Hub.
func NewHub() *Hub {
	return &Hub{
		rooms: make(map[string]*Room),
	}
}

// Join добавляет участника в комнату (создаёт комнату если не существует).
func (h *Hub) Join(roomID, name string) *Peer {
	h.mu.Lock()
	r, ok := h.rooms[roomID]
	if !ok {
		r = &Room{
			ID:    roomID,
			peers: make(map[*Peer]struct{}),
		}
		h.rooms[roomID] = r
		log.Printf("hub: created room %q", roomID)
	}
	h.mu.Unlock()

	p := &Peer{
		Name: name,
		Room: r,
		Send: make(chan []byte, 64),
	}

	r.addPeer(p)
	log.Printf("hub: %q joined room %q (%d peers)", name, roomID, r.PeerCount())

	return p
}

// Leave убирает участника из комнаты. Если комната пустая — удаляет её.
func (h *Hub) Leave(p *Peer) {
	r := p.Room

	empty := r.removePeer(p)
	close(p.Send)

	log.Printf("hub: %q left room %q (%d peers)", p.Name, r.ID, r.PeerCount())

	if empty {
		h.mu.Lock()
		// Повторная проверка — вдруг кто-то успел зайти
		if r.PeerCount() == 0 {
			delete(h.rooms, r.ID)
			log.Printf("hub: deleted empty room %q", r.ID)
		}
		h.mu.Unlock()
	}
}
