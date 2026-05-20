import { createServer } from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { attachWebSocketServer } from "./ws/price-stream.js";
import { startScheduler } from "./lib/scheduler.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
attachWebSocketServer(server);

server.listen(port, () => {
  logger.info({ port }, "Server listening");
  startScheduler();
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
