package room

import "testing"

func TestTryAcquire_Success(t *testing.T) {
	h := NewHub()
	p := h.Join("test", "alice")
	defer h.Leave(p)

	if !p.Room.TryAcquire(p) {
		t.Fatal("expected acquire to succeed for first peer")
	}
	if p.Room.Talker != p {
		t.Fatal("expected talker to be alice")
	}
}

func TestTryAcquire_Denied(t *testing.T) {
	h := NewHub()
	p1 := h.Join("test", "alice")
	p2 := h.Join("test", "bob")
	defer h.Leave(p1)
	defer h.Leave(p2)

	if !p1.Room.TryAcquire(p1) {
		t.Fatal("expected acquire to succeed for alice")
	}
	if p2.Room.TryAcquire(p2) {
		t.Fatal("expected acquire to be denied for bob while alice holds PTT")
	}
	if p2.Room.Talker != p1 {
		t.Fatal("expected talker to still be alice")
	}
}

func TestRelease(t *testing.T) {
	h := NewHub()
	p1 := h.Join("test", "alice")
	p2 := h.Join("test", "bob")
	defer h.Leave(p1)
	defer h.Leave(p2)

	p1.Room.TryAcquire(p1)
	p1.Room.Release(p1)

	if p1.Room.Talker != nil {
		t.Fatal("expected talker to be nil after release")
	}

	// bob should now be able to acquire
	if !p2.Room.TryAcquire(p2) {
		t.Fatal("expected acquire to succeed for bob after alice released")
	}
	if p2.Room.Talker != p2 {
		t.Fatal("expected talker to be bob")
	}
}

func TestRelease_WrongPeer(t *testing.T) {
	h := NewHub()
	p1 := h.Join("test", "alice")
	p2 := h.Join("test", "bob")
	defer h.Leave(p1)
	defer h.Leave(p2)

	p1.Room.TryAcquire(p1)
	p2.Room.Release(p2) // bob tries to release alice's PTT — should be ignored

	if p1.Room.Talker != p1 {
		t.Fatal("expected talker to still be alice after wrong peer release")
	}
}

func TestLeave_ReleasesPTT(t *testing.T) {
	h := NewHub()
	p1 := h.Join("test", "alice")
	p2 := h.Join("test", "bob")

	p1.Room.TryAcquire(p1)
	r := p1.Room
	h.Leave(p1)

	if r.Talker != nil {
		t.Fatal("expected talker to be nil after talker left")
	}

	// bob should be able to acquire
	if !r.TryAcquire(p2) {
		t.Fatal("expected acquire to succeed for bob after alice left")
	}
	h.Leave(p2)
}

func TestBroadcast_SkipsSender(t *testing.T) {
	h := NewHub()
	p1 := h.Join("test", "alice")
	p2 := h.Join("test", "bob")
	p3 := h.Join("test", "carol")
	defer h.Leave(p1)
	defer h.Leave(p2)
	defer h.Leave(p3)

	msg := []byte("hello")
	p1.Room.Broadcast(p1, msg)

	// p2 and p3 should receive the message
	select {
	case got := <-p2.Send:
		if string(got) != "hello" {
			t.Fatalf("p2 got %q, want %q", got, "hello")
		}
	default:
		t.Fatal("expected p2 to receive message")
	}

	select {
	case got := <-p3.Send:
		if string(got) != "hello" {
			t.Fatalf("p3 got %q, want %q", got, "hello")
		}
	default:
		t.Fatal("expected p3 to receive message")
	}

	// p1 (sender) should NOT receive
	select {
	case <-p1.Send:
		t.Fatal("sender should not receive own broadcast")
	default:
		// ok
	}
}
