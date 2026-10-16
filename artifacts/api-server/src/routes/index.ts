import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import accountRouter from "./account";
import positionsRouter from "./positions";
import leverageRouter from "./leverage";
import marginRouter from "./margin";
import tradeRouter from "./trade";
import favoritesRouter from "./favorites";
import triggersRouter from "./triggers";
import eventlogRouter from "./eventlog";
import pricesRouter from "./prices";
import signalRouter from "./signal";
import safeguardRouter from "./safeguard";
import journalRouter from "./journal";
import tradePlanRouter from "./tradePlan";
import edgeScoreRouter from "./edge-score";
import autoEntryRouter from "./autoEntry";
import hindsightRouter from "./hindsight";
import fingerprintRouter from "./fingerprint";
import governorRouter from "./governor";
import exportStateRouter from "./exportState";

const router: IRouter = Router();

/**
 * Require a valid passcode session cookie.
 * Returns 401 if the session is missing or expired.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Public routes — no auth required
router.use(healthRouter);
router.use(authRouter);

// All routes below require a valid session
router.use(requireAuth);

router.use(accountRouter);
router.use(positionsRouter);
router.use(leverageRouter);
router.use(marginRouter);
router.use(tradeRouter);
router.use(favoritesRouter);
router.use(triggersRouter);
router.use(eventlogRouter);
router.use(pricesRouter);
router.use(signalRouter);
router.use(safeguardRouter);
router.use(journalRouter);
router.use(tradePlanRouter);
router.use(edgeScoreRouter);
router.use(autoEntryRouter);
router.use(hindsightRouter);
router.use(fingerprintRouter);
router.use(governorRouter);
router.use(exportStateRouter);

export default router;
