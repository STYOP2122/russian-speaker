export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("OK");
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const room = url.searchParams.get("room") || "ru-am";
    const id = env.ROOMS.idFromName(room);
    return env.ROOMS.get(id).fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.clients = new Map(); // clientId -> ws
  }

  async fetch() {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let myId = null;

    const broadcast = (data, except = null) => {
      for (const [id, ws] of this.clients) {
        if (except && id === except) continue;
        try {
          ws.send(data);
        } catch {
          // ignore
        }
      }
    };

    const maybeReady = () => {
      if (this.clients.size === 2) {
        const [initiator] = this.clients.keys(); // first joined
        broadcast(JSON.stringify({ t: "ready", initiator }));
      }
    };

    server.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === "join") {
          myId = String(msg.from || crypto.randomUUID());
          this.clients.set(myId, server);
          server.send(JSON.stringify({ t: "joined", id: myId }));
          maybeReady();
          return;
        }
        if (msg.t === "sdp" || msg.t === "ice") {
          broadcast(ev.data, msg.from ? String(msg.from) : null);
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
      if (myId && this.clients.get(myId) === server) this.clients.delete(myId);
      if (this.clients.size === 0) return;
      // If one left, notify the other.
      broadcast(JSON.stringify({ t: "peer-left" }));
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}

