import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { portfolioRouter } from "./portfolio";
import { positionsRouter } from "./positions";
import { ordersRouter } from "./orders";
import { agentsRouter } from "./agents";
import { marketRouter } from "./market";
import { analyticsRouter } from "./analytics";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/portfolio", portfolioRouter);
router.use("/positions", positionsRouter);
router.use("/orders", ordersRouter);
router.use("/agents", agentsRouter);
router.use("/market", marketRouter);
router.use("/analytics", analyticsRouter);

export default router;
