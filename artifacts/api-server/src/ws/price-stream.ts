import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { tickAllPrices } from "../lib/market-data.js";
import { logger } from "../lib/logger.js";

let wss: WebSocketServer | null = null;
let broadcastInterval: ReturnType<typeof setInterval> | null = null;

export function attachWebSocketServer(server: Server) {
  wss = new WebSocketServer({ server, path: "/api/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    logger.info({ url: req.url }, "WebSocket client connected");

    ws.on("close", () => {
      logger.info("WebSocket client disconnected");
    });

    ws.on("error", (err) => {
      logger.warn({ err }, "WebSocket client error");
    });

    // Send an immediate tick on connect so the client has data right away
    const ticks = tickAllPrices();
    ws.send(JSON.stringify({ type: "ticks", ticks }));
  });

  // Broadcast price ticks to all connected clients every 2 seconds
  broadcastInterval = setInterval(() => {
    if (!wss || wss.clients.size === 0) return;
    const ticks = tickAllPrices();
    const payload = JSON.stringify({ type: "ticks", ticks });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }, 2000);

  logger.info("WebSocket price stream attached at /api/ws");
}

export function closeWebSocketServer() {
  if (broadcastInterval) clearInterval(broadcastInterval);
  wss?.close();
}
