// Model API keys come from the person using Shoal, never from the server's
// environment. The website keeps them in the browser and sends them with every
// request (X-Anthropic-Key, X-OpenAI-Key, X-OpenRouter-Key); the middleware
// below holds them for that request and everything it starts in the
// background, so model calls (agents.js, competitors.js, proof.js) use the
// keys of whoever kicked them off. Keys are never stored or logged.
import { AsyncLocalStorage } from "node:async_hooks";

export const PROVIDERS = ["anthropic", "openai", "openrouter"];
const HEADERS = { anthropic: "x-anthropic-key", openai: "x-openai-key", openrouter: "x-openrouter-key" };
const NAMES = { anthropic: "an Anthropic", openai: "an OpenAI", openrouter: "an OpenRouter" };

const store = new AsyncLocalStorage();
const NONE = Object.freeze({});

// Runs fn with these keys ({ anthropic, openai, openrouter }; missing = none).
export const withKeys = (keys, fn) => store.run(clean(keys), fn);

export function keysMiddleware(req, _res, next) {
  store.run(clean(Object.fromEntries(PROVIDERS.map((p) => [p, req.get(HEADERS[p])]))), next);
}

export const userKeys = () => store.getStore() ?? NONE;
export const keyFor = (provider) => userKeys()[provider] ?? null;
export const hasKey = (provider) => Boolean(keyFor(provider));
// Which providers this request brought keys for.
export const keyStatus = () => Object.fromEntries(PROVIDERS.map((p) => [p, hasKey(p)]));
export const needKey = (provider) => `Add ${NAMES[provider]} API key under API keys to run these models`;

function clean(keys = {}) {
  const out = {};
  for (const p of PROVIDERS) {
    const k = String(keys[p] ?? "").trim();
    // Header values are ASCII; anything with spaces or controls isn't a key.
    if (k && k.length <= 512 && /^[\x21-\x7e]+$/.test(k)) out[p] = k;
  }
  return Object.freeze(out);
}
