import { createServer } from "http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { addConnection, removeConnection, getConnections } from "./connections";
import { getRedisConnectionOptions } from "../lib/redis-config";

const WHITELIST_CHANNEL = "whitelist:change";
const WS_PORT = Number(process.env.WS_PORT) || 3001;
const HEARTBEAT_INTERVAL = 30_000;

const prisma = new PrismaClient();
const redisOptions = getRedisConnectionOptions();
const subscriber = new Redis(redisOptions);

// Track liveness per socket
const alive = new WeakMap<WebSocket, boolean>();

// --- HTTP server with /health endpoint ---
const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// --- WebSocket server ---
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost:${WS_PORT}`);

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const serverId = url.searchParams.get("serverId");
  const token = url.searchParams.get("token");

  if (!serverId || !token) {
    socket.destroy();
    return;
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");

  prisma.server
    .findUnique({
      where: { id: serverId },
      select: { apiKeyHash: true },
    })
    .then((server) => {
      if (!server || server.apiKeyHash !== tokenHash) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, serverId);
      });
    })
    .catch((err) => {
      console.error("[ws] Auth lookup failed:", err);
      socket.destroy();
    });
});

wss.on("connection", (ws: WebSocket, _req: unknown, serverId: string) => {
  console.log(`[ws] Client connected for server ${serverId}`);
  addConnection(serverId, ws);
  alive.set(ws, true);

  ws.on("pong", () => {
    alive.set(ws, true);
  });

  ws.on("close", () => {
    console.log(`[ws] Client disconnected from server ${serverId}`);
    removeConnection(serverId, ws);
  });

  ws.on("error", (err) => {
    console.error(`[ws] Socket error for server ${serverId}:`, err);
    removeConnection(serverId, ws);
  });
});

// --- Redis subscriber ---
subscriber.subscribe(WHITELIST_CHANNEL, (err) => {
  if (err) {
    console.error("[ws] Failed to subscribe to Redis channel:", err);
    return;
  }
  console.log(`[ws] Subscribed to Redis channel: ${WHITELIST_CHANNEL}`);
});

subscriber.on("message", (channel, message) => {
  if (channel !== WHITELIST_CHANNEL) return;

  try {
    const parsed: { serverId: string } = JSON.parse(message);
    const clients = getConnections(parsed.serverId);
    if (!clients) return;

    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  } catch (err) {
    console.error("[ws] Failed to process Redis message:", err);
  }
});

// --- Heartbeat ---
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_INTERVAL);

// --- Start listening ---
httpServer.listen(WS_PORT, () => {
  console.log(`[ws] WebSocket server listening on port ${WS_PORT}`);
});

// --- Graceful shutdown ---
function shutdown() {
  console.log("[ws] Shutting down...");
  clearInterval(heartbeat);

  for (const ws of wss.clients) {
    ws.close(1001, "Server shutting down");
  }

  subscriber
    .unsubscribe(WHITELIST_CHANNEL)
    .then(() => subscriber.quit())
    .catch((err) => console.error("[ws] Redis cleanup error:", err));

  wss.close(() => {
    httpServer.close(() => {
      prisma
        .$disconnect()
        .then(() => {
          console.log("[ws] Shutdown complete");
          process.exit(0);
        })
        .catch(() => {
          process.exit(1);
        });
    });
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
