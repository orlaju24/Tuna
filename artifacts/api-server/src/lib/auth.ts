/**
 * Stateless passcode auth.
 *
 * A single APP_PASSCODE env var protects the app.
 * On successful login, an HMAC-signed cookie is issued containing only an
 * expiry timestamp — no DB round-trips, no external OAuth discovery calls.
 * The HMAC is keyed with SESSION_SECRET, so tokens are unforgeable without
 * the secret, and expire automatically.
 */
import crypto from "crypto";
import { type Request, type Response } from "express";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET env var is not set");
  return s;
}

export function verifyPasscode(input: string): boolean {
  const expected = process.env.APP_PASSCODE;
  if (!expected) return false;
  if (input.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(input), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Create a signed session token: "<expiry_ms>.<hmac_hex>" */
export function createSessionToken(): string {
  const expiry = String(Date.now() + SESSION_TTL_MS);
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(expiry)
    .digest("hex");
  return `${expiry}.${sig}`;
}

/** Returns true if the token is valid and not expired. */
export function verifySessionToken(token: string): boolean {
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expiry = token.slice(0, dot);
  const sig    = token.slice(dot + 1);
  const expectedSig = crypto
    .createHmac("sha256", getSecret())
    .update(expiry)
    .digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      return false;
    }
  } catch {
    return false;
  }
  return Date.now() < parseInt(expiry, 10);
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   true,
    sameSite: "lax",
    path:     "/",
    maxAge:   SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionToken(req: Request): string | undefined {
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return req.cookies?.[SESSION_COOKIE];
}
