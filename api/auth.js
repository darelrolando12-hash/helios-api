import { createHmac, timingSafeEqual } from 'crypto';

const _attempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const state = _attempts.get(ip);
  if (!state || now - state.windowStart > WINDOW_MS) {
    _attempts.set(ip, { count: 1, windowStart: now });
    return { allowed: true, attemptsLeft: MAX_ATTEMPTS - 1 };
  }
  if (state.count >= MAX_ATTEMPTS) {
    const minutesLeft = Math.ceil((state.windowStart + WINDOW_MS - now) / 60_000);
    return { allowed: false, minutesLeft, attemptsLeft: 0 };
  }
  state.count++;
  return { allowed: true, attemptsLeft: MAX_ATTEMPTS - state.count };
}

function recordSuccess(ip) {
  _attempts.delete(ip);
}

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET not configured');
  return s;
}

function signToken(payload) {
  const data = JSON.stringify(payload);
  const b64 = Buffer.from(data).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;
    const expectedSig = createHmac('sha256', getSecret()).update(b64).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { action } = body || {};

  if (action === 'verify') {
    const { token } = body;
    if (!token) return res.status(200).json({ valid: false });
    try {
      const payload = verifyToken(token);
      return res.status(200).json({ valid: !!payload });
    } catch {
      return res.status(200).json({ valid: false });
    }
  }

  if (action === 'login') {
    const { password } = body;
    if (!password) return res.status(400).json({ error: 'Missing password' });

    const ip = (req.headers['x-forwarded-for'] || '127.0.0.1').split(',')[0].trim();
    const rate = checkRateLimit(ip);

    if (!rate.allowed) {
      return res.status(429).json({ error: 'Too many attempts', minutesLeft: rate.minutesLeft });
    }

    const expected = process.env.APP_PASSWORD;
    if (!expected) {
      return res.status(500).json({ error: 'APP_PASSWORD not configured' });
    }

    let match = false;
    try {
      const a = Buffer.from(password);
      const b = Buffer.from(expected);
      match = a.length === b.length && timingSafeEqual(a, b);
    } catch {
      match = false;
    }

    if (!match) {
      return res.status(401).json({ error: 'Invalid access key', attemptsLeft: rate.attemptsLeft });
    }

    recordSuccess(ip);
    const payload = { iss: 'helios', exp: Date.now() + TOKEN_TTL_MS };
    const token = signToken(payload);
    return res.status(200).json({ token, exp: payload.exp });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
