import OpenAI from "openai";

// Lazily construct the client so a missing env var doesn't crash the server at
// startup (all other routes stay healthy; only the trade-plan route will fail
// with a clear error when called if the integration isn't configured).
let _openai: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const apiKey  = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  if (!baseURL || !apiKey) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_BASE_URL and AI_INTEGRATIONS_OPENAI_API_KEY must be set " +
        "(provisioned automatically by the Replit AI Integrations setup).",
    );
  }
  _openai = new OpenAI({ baseURL, apiKey });
  return _openai;
}

// Convenience re-export used by tradePlanAnalyzer so callers don't have to
// change — the Proxy below forwards every property access through getOpenAI().
export const openai: OpenAI = new Proxy({} as OpenAI, {
  get(_target, prop) {
    return (getOpenAI() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
