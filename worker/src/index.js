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
    this.clients = new Map(); // clientId -> { ws, side }
    this.sideToClientId = new Map(); // side -> clientId
  }

  async fetch(request) {
    const url = new URL(request.url);
    const urlSide = String(url.searchParams.get("side") || "");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let myId = null;
    let mySide = null;

    const broadcast = (data, except = null) => {
      for (const [id, entry] of this.clients) {
        if (except && id === except) continue;
        try {
          entry.ws.send(data);
        } catch {
          // ignore
        }
      }
    };

    const pickInitiator = () => {
      // Prefer RU as offerer when both sides are present.
      const ru = this.sideToClientId.get("ru");
      if (ru && this.clients.has(ru)) return ru;
      const [first] = this.clients.keys();
      return first || null;
    };

    const maybeReady = () => {
      const hasRu = this.sideToClientId.has("ru");
      const hasAm = this.sideToClientId.has("am");
      if (hasRu && hasAm) {
        const initiator = pickInitiator();
        if (initiator) broadcast(JSON.stringify({ t: "ready", initiator }));
      }
    };

    server.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === "join") {
          myId = String(msg.from || crypto.randomUUID());
          const side = String(msg.side || urlSide || "");
          if (side !== "ru" && side !== "am") {
            server.send(JSON.stringify({ t: "denied", reason: "bad-side" }));
            server.close(1008, "bad-side");
            return;
          }

          const occupiedBy = this.sideToClientId.get(side);
          if (occupiedBy && occupiedBy !== myId && this.clients.has(occupiedBy)) {
            server.send(JSON.stringify({ t: "denied", reason: "side-taken", side }));
            server.close(1008, "side-taken");
            return;
          }

          mySide = side;
          this.sideToClientId.set(side, myId);
          this.clients.set(myId, { ws: server, side });
          server.send(JSON.stringify({ t: "joined", id: myId, side }));
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
      if (myId && this.clients.get(myId)?.ws === server) this.clients.delete(myId);
      if (mySide && this.sideToClientId.get(mySide) === myId) this.sideToClientId.delete(mySide);
      if (this.clients.size === 0) return;
      // If one left, notify the other.
      broadcast(JSON.stringify({ t: "peer-left" }));
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}

