import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Global error handler — catches any unhandled errors and returns JSON
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ err: err?.message, stack: err?.stack, url: req.url }, "Unhandled error");
  res.status(500).json({ error: err?.message ?? "Internal server error" });
});

export default app;
