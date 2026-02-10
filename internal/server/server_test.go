package server

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"teletalkie/internal/room"
	"teletalkie/web"
)

func setupTestServer(t *testing.T) (*httptest.Server, *room.Hub) {
	t.Helper()
	hub := room.NewHub()
	srv := New(":0", web.FS, hub)
	ts := httptest.NewServer(srv.mux)
	t.Cleanup(ts.Close)
	return ts, hub
}

func dial(t *testing.T, ts *httptest.Server, roomID, name string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := "ws" + ts.URL[len("http"):] + "/ws?room=" + roomID + "&name=" + name
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", name, err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

func sendMsg(t *testing.T, conn *websocket.Conn, data []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("send: %v", err)
	}
}

func readMsg(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return data
}

// readMsgSkip reads messages from the connection, skipping any PEER_INFO (0x14)
// messages, and returns the first non-PEER_INFO message.
func readMsgSkip(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	for {
		data := readMsg(t, conn)
		if len(data) > 0 && data[0] == MsgPeerInfo {
			continue
		}
		return data
	}
}

func TestPTTGrantedAndDenied(t *testing.T) {
	ts, _ := setupTestServer(t)

	alice := dial(t, ts, "room1", "alice")
	bob := dial(t, ts, "room1", "bob")

	// Alice requests PTT — should be granted.
	sendMsg(t, alice, []byte{MsgPTTOn})
	resp := readMsgSkip(t, alice)
	if len(resp) != 1 || resp[0] != MsgPTTGranted {
		t.Fatalf("alice: expected PTT_GRANTED (0x%02x), got %v", MsgPTTGranted, resp)
	}

	// Bob requests PTT while alice holds it — should be denied.
	sendMsg(t, bob, []byte{MsgPTTOn})
	resp = readMsgSkip(t, bob)
	if len(resp) != 1 || resp[0] != MsgPTTDenied {
		t.Fatalf("bob: expected PTT_DENIED (0x%02x), got %v", MsgPTTDenied, resp)
	}
}

func TestPTTReleaseNotifiesOthers(t *testing.T) {
	ts, _ := setupTestServer(t)

	alice := dial(t, ts, "room1", "alice")
	bob := dial(t, ts, "room1", "bob")

	// Alice acquires PTT.
	sendMsg(t, alice, []byte{MsgPTTOn})
	readMsgSkip(t, alice) // GRANTED

	// Alice releases PTT.
	sendMsg(t, alice, []byte{MsgPTTOff})

	// Bob should receive PTT_RELEASED.
	resp := readMsgSkip(t, bob)
	if len(resp) != 1 || resp[0] != MsgPTTReleased {
		t.Fatalf("bob: expected PTT_RELEASED (0x%02x), got %v", MsgPTTReleased, resp)
	}
}

func TestMediaChunkRelay(t *testing.T) {
	ts, _ := setupTestServer(t)

	alice := dial(t, ts, "room1", "alice")
	bob := dial(t, ts, "room1", "bob")
	carol := dial(t, ts, "room1", "carol")

	// Alice acquires PTT.
	sendMsg(t, alice, []byte{MsgPTTOn})
	readMsgSkip(t, alice) // GRANTED

	// Alice sends a media chunk.
	chunk := []byte{MsgMediaChunk, 0xDE, 0xAD, 0xBE, 0xEF}
	sendMsg(t, alice, chunk)

	// Bob and Carol should receive the relayed chunk.
	for _, pair := range []struct {
		name string
		conn *websocket.Conn
	}{{"bob", bob}, {"carol", carol}} {
		resp := readMsgSkip(t, pair.conn)
		if len(resp) < 1 || resp[0] != MsgRelayChunk {
			t.Fatalf("%s: expected MsgRelayChunk (0x%02x), got 0x%02x", pair.name, MsgRelayChunk, resp[0])
		}
		payload := resp[1:]
		if len(payload) != 4 || payload[0] != 0xDE || payload[1] != 0xAD || payload[2] != 0xBE || payload[3] != 0xEF {
			t.Fatalf("%s: unexpected payload %v", pair.name, payload)
		}
	}
}

func TestMediaChunkIgnoredIfNotTalker(t *testing.T) {
	ts, _ := setupTestServer(t)

	alice := dial(t, ts, "room1", "alice")
	bob := dial(t, ts, "room1", "bob")

	// Alice acquires PTT.
	sendMsg(t, alice, []byte{MsgPTTOn})
	readMsgSkip(t, alice) // GRANTED

	// Bob (not talker) tries to send a media chunk — should be silently ignored.
	sendMsg(t, bob, []byte{MsgMediaChunk, 0x01, 0x02})

	// Now alice sends a real chunk so we can verify bob's chunk was dropped.
	realChunk := []byte{MsgMediaChunk, 0xAA, 0xBB}
	sendMsg(t, alice, realChunk)

	resp := readMsgSkip(t, bob)
	if resp[0] != MsgRelayChunk {
		t.Fatalf("bob: expected relay chunk, got 0x%02x", resp[0])
	}
	if resp[1] != 0xAA || resp[2] != 0xBB {
		t.Fatalf("bob: expected alice's chunk [AA BB], got %v", resp[1:])
	}
}

func TestPTTAcquireAfterRelease(t *testing.T) {
	ts, _ := setupTestServer(t)

	alice := dial(t, ts, "room1", "alice")
	bob := dial(t, ts, "room1", "bob")

	// Alice acquires and releases PTT.
	sendMsg(t, alice, []byte{MsgPTTOn})
	readMsgSkip(t, alice) // GRANTED
	sendMsg(t, alice, []byte{MsgPTTOff})
	readMsgSkip(t, bob) // PTT_RELEASED

	// Bob should now be able to acquire PTT.
	sendMsg(t, bob, []byte{MsgPTTOn})
	resp := readMsgSkip(t, bob)
	if len(resp) != 1 || resp[0] != MsgPTTGranted {
		t.Fatalf("bob: expected PTT_GRANTED after alice released, got %v", resp)
	}

	// Bob sends a chunk — alice should receive it.
	sendMsg(t, bob, []byte{MsgMediaChunk, 0xFF})
	resp = readMsgSkip(t, alice)
	if resp[0] != MsgRelayChunk || resp[1] != 0xFF {
		t.Fatalf("alice: expected relay chunk [13 FF], got %v", resp)
	}
}

func TestPeerInfoOnJoinAndLeave(t *testing.T) {
	ts, _ := setupTestServer(t)

	alice := dial(t, ts, "room1", "alice")

	// Alice should receive PEER_INFO on her own join.
	resp := readMsg(t, alice)
	if len(resp) < 1 || resp[0] != MsgPeerInfo {
		t.Fatalf("alice: expected PEER_INFO (0x%02x) on self join, got 0x%02x", MsgPeerInfo, resp[0])
	}

	// Bob joins — alice should receive another PEER_INFO.
	_ = dial(t, ts, "room1", "bob")
	resp = readMsg(t, alice)
	if len(resp) < 1 || resp[0] != MsgPeerInfo {
		t.Fatalf("alice: expected PEER_INFO (0x%02x) on bob join, got 0x%02x", MsgPeerInfo, resp[0])
	}
}
