// Small helpers shared by the API routes.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (status, message) => { throw new HttpError(status, message); };

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;
export const isEmail = (value) => typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);

export function str(value, { max = 200, required = false, field = 'value' } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' && typeof value !== 'number') fail(400, `${field} must be text`);
  const out = String(value).trim();
  if (required && !out) fail(400, `${field} is required`);
  if (out.length > max) fail(400, `${field} is too long (max ${max})`);
  return out;
}

export function id(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(400, 'Invalid id');
  return n;
}

// Fixed-window in-memory rate limiter, keyed by e.g. IP + route.
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const k = key(req);
    const t = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset < t) {
      entry = { count: 0, reset: t + windowMs };
      hits.set(k, entry);
      if (hits.size > 10000) for (const [hk, hv] of hits) if (hv.reset < t) hits.delete(hk);
    }
    if (++entry.count > max) return res.status(429).json({ error: 'Too many requests, please try again later.' });
    next();
  };
}
