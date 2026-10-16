import { Router, type Request, type Response } from "express";
import {
  verifyPasscode,
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from "../lib/auth";

const router = Router();

/**
 * POST /api/auth/login
 * Body: { passcode: string }
 * Returns 200 + sets session cookie on success, 401 on wrong passcode,
 * 503 if APP_PASSCODE env var is not configured yet.
 */
router.post("/auth/login", (req: Request, res: Response) => {
  if (!process.env.APP_PASSCODE) {
    res.status(503).json({
      error: "App not configured",
      hint: "Set the APP_PASSCODE environment variable to enable login.",
    });
    return;
  }

  const { passcode } = req.body ?? {};
  if (typeof passcode !== "string" || !verifyPasscode(passcode)) {
    res.status(401).json({ error: "Invalid passcode" });
    return;
  }

  const token = createSessionToken();
  setSessionCookie(res, token);
  res.json({ ok: true });
});

/**
 * POST /api/auth/logout
 * Clears the session cookie.
 */
router.post("/auth/logout", (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/**
 * GET /api/auth/status
 * Returns whether the caller has a valid session.
 */
router.get("/auth/status", (req: Request, res: Response) => {
  res.json({ authenticated: req.isAuthenticated() });
});

export default router;
