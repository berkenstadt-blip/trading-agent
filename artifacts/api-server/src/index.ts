import { createServer } from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { attachWebSocketServer } from "./ws/price-stream.js";
import { startScheduler } from "./lib/scheduler.js";
import { seedAgents } from "./lib/seed-agents.js";

const rawPort = process.env["PORT"] ?? "8080";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
attachWebSocketServer(server);

server.listen(port, async () => {
  logger.info({ port }, "Server listening");
  await seedAgents().catch(e => logger.error({ e }, "Agent seed failed"));
  startScheduler();
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
