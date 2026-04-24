export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      return new Response("OK", { status: 200 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const room = url.searchParams.get("room");
    if (!room) return new Response("Missing ?room=", { status: 400 });

    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.clients = new Map(); // clientId -> websocket
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let thisClientId = null;

    const broadcast = (data, exceptId = null) => {
      for (const [id, ws] of this.clients) {
        if (exceptId && id === exceptId) continue;
        try {
          ws.send(data);
        } catch {
          // ignore
        }
      }
    };

    server.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === "join") {
          thisClientId = String(msg.from || crypto.randomUUID());
          this.clients.set(thisClientId, server);

          // If exactly 2 peers, tell them who should initiate.
          if (this.clients.size === 2) {
            const [first] = this.clients.keys();
            const payload = JSON.stringify({ t: "peer-joined", initiator: first });
            broadcast(payload);
          } else {
            // Still acknowledge join.
            server.send(JSON.stringify({ t: "joined", id: thisClientId }));
          }
          return;
        }

        // Forward SDP/ICE to everyone else in the room.
        if (msg.t === "sdp" || msg.t === "ice") {
          broadcast(ev.data, msg.from ? String(msg.from) : null);
          return;
        }
      } catch (e) {
        try {
          server.send(JSON.stringify({ t: "err", message: String(e?.message ?? e) }));
        } catch {
          // ignore
        }
      }
    });

    const cleanup = () => {
      if (thisClientId && this.clients.get(thisClientId) === server) {
        this.clients.delete(thisClientId);
      }
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}

