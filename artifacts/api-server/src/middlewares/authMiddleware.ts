import { type Request, type Response, type NextFunction } from "express";
import { getSessionToken, verifySessionToken } from "../lib/auth";

declare global {
  namespace Express {
    interface Request {
      isAuthenticated(): boolean;
    }
  }
}

/**
 * Attaches req.isAuthenticated() — synchronous, no DB or network calls.
 * Simply verifies the HMAC-signed session cookie.
 */
export function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const token = getSessionToken(req);
  const ok = token ? verifySessionToken(token) : false;
  req.isAuthenticated = () => ok;
  next();
}
