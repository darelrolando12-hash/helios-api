const POLYGON_KEY  = process.env.POLYGON_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET ?? 'helios-cron';

// Tickers needed for market-wide RIP/DUMP detection
const MARKET_TICKERS = ['SPY', 'QQQ', 'IWM'];
const INDEX_TICKER_MAP = { SPX: 'I:SPX', NDX: 'I:NDX', VIX: 'I:VIX', SPXW: 'I:SPX' };

// Detection thresholds — mirrors openPlayDetector.ts
const MIN_MOVE_PCT    = 0.4;
const STRONG_MOVE_PCT = 0.75;
const VOLUME_MULT     = 1.2;
const COOLDOWN_MS     = 45 * 60 * 1000; // 45 min between same-direction signals
const ENTRY_WINDOW_MIN = 90; // minutes entry window stays open after detection

// ─── CT time helpers ──────────────────────────────────────────────────────────

function getCTNow() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return {
    h:        ct.getHours(),
    m:        ct.getMinutes(),
    totalMin: ct.getHours() * 60 + ct.getMinutes(),
    dateStr:  ct.toLocaleDateString('en-CA'),
    isoStr:   new Date().toISOString(), // always UTC for DB storage
  };
}

function isWeekend() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return ct.getDay() === 0 || ct.getDay() === 6;
}

function isMarketHours(totalMin) {
  // 8:00 AM CT pre-check through 3:05 PM CT close
  return totalMin >= 8 * 60 && totalMin <= 15 * 60 + 5;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatCTTime(isoUtc) {
  return new Date(isoUtc).toLocaleString('en-US', {
    timeZone:     'America/Chicago',
    hour:         'numeric',
    minute:       '2-digit',
    hour12:       true,
  }) + ' CT';
}

// ─── Polygon fetch ────────────────────────────────────────────────────────────

async function polyFetch(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Helios-MarketIntel/1.0' },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 429) {
      if (attempt < 3) {
        await sleep(800 * attempt);
        return polyFetch(url, attempt + 1);
      }
      return null;
    }
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function toPolygonAggTicker(ticker) {
  if (ticker.startsWith('^')) return ticker.replace('^', 'I:');
  return INDEX_TICKER_MAP[ticker] ?? ticker;
}

// ─── DB-first prevClose helper ───────────────────────────────────────────────
// Reads prev_close from daily_market_data — written by daily cron at 4:05 PM CT.
// Eliminates the /v2/aggs/ticker/{sym}/prev call on every 60s cycle.
async function getDBPrevClose(symbol) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/daily_market_data?symbol=eq.${encodeURIComponent(symbol)}&order=date.desc&limit=1&select=prev_close,date`;
    const r = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    // Accept up to 7 days old — prev-day bar is valid all week
    const rowDate = new Date(row.date + 'T00:00:00');
    const ageMs = Date.now() - rowDate.getTime();
    if (ageMs > 7 * 24 * 60 * 60 * 1000) return null;
    return row.prev_close ?? null;
  } catch {
    return null;
  }
}

// ─── Fetch live quote for a ticker — Yahoo-first, zero Stocks Basic calls ────
//
// PERMANENT FIX: /v2/last/stocks and /v2/aggs/prev are Stocks Basic endpoints (5 req/min).
// Yahoo Finance provides live price + prevClose in one call for any ticker.
// DB overlay (daily cron) provides precise prev_close when available.

async function fetchLiveQuote(ticker) {
  // 1. DB prev-day overlay — eliminates reliance on Yahoo prevClose field
  let prevClose = await getDBPrevClose(ticker);

  // 2. Yahoo Finance for live price (and prevClose if DB missed)
  // Works for equities (SPY → SPY), ETFs (IWM → IWM), indices (SPX → ^GSPC).
  try {
    const yahooSym = ticker === 'SPX' || ticker === 'SPXW' ? '^GSPC'
      : ticker === 'NDX' ? '^NDX'
      : ticker === 'VIX' ? '^VIX'
      : ticker.startsWith('^') ? ticker
      : ticker.replace(/^I:/, '^');
    const yRes = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1m&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (yRes.ok) {
      const yData = await yRes.json();
      const meta  = yData?.chart?.result?.[0]?.meta;
      if (meta) {
        const price = meta.regularMarketPrice ?? 0;
        if (!prevClose) prevClose = meta.previousClose ?? meta.chartPreviousClose ?? 0;
        if (price > 0) {
          console.log(`[market-intel] ${ticker} live=${price} prevClose=${prevClose} src=yahoo`);
          const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
          return { ticker, price, prevClose, changePct, prevVolume: meta.regularMarketVolume ?? 0 };
        }
      }
    }
  } catch (e) {
    console.warn(`[market-intel] ${ticker} Yahoo failed — ${e.message}`);
  }

  // 3. DB-only fallback (market closed / Yahoo unavailable)
  if (prevClose > 0) {
    console.log(`[market-intel] ${ticker}: Yahoo unavailable, using DB prevClose=${prevClose}`);
    return { ticker, price: prevClose, prevClose, changePct: 0, prevVolume: 0 };
  }

  console.warn(`[market-intel] ${ticker}: all sources failed`);
  return null;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function dbRead(table, filters) {
  const params = Object.entries(filters)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

async function dbUpsert(table, row) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  return res.ok;
}

async function dbDeleteOld(table, field, olderThanIso) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${field}=lt.${olderThanIso}`;
  await fetch(url, {
    method:  'DELETE',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
}

// ─── Cooldown management (DB-backed, not localStorage) ───────────────────────

async function isCoolingDown(cooldownKey, ct) {
  try {
    const rows = await dbRead('market_signal_cooldowns', { cooldown_key: `eq.${cooldownKey}` });
    if (!rows.length) return false;
    const lastFiredAt = new Date(rows[0].fired_at).getTime();
    return (Date.now() - lastFiredAt) < COOLDOWN_MS;
  } catch {
    return false; // fail open — better to show than suppress
  }
}

async function markCooldown(cooldownKey) {
  await dbUpsert('market_signal_cooldowns', {
    cooldown_key: cooldownKey,
    fired_at:     new Date().toISOString(),
  });
}

// ─── Signal status computation (server-side) ─────────────────────────────────
// This is the authoritative status. Devices read this — they never compute it themselves.

function computeSignalStatus(detectedAtIso, entryWindowClosesAtIso) {
  const now      = Date.now();
  const closesAt = new Date(entryWindowClosesAtIso).getTime();
  const msLeft   = closesAt - now;

  if (msLeft <= 0)              return 'expired';
  if (msLeft < 5 * 60 * 1000)  return 'fading';  // < 5 min left
  return 'active';
}

// ─── RIP/DUMP detection — mirrors openPlayDetector.ts Tier 1 ─────────────────

async function detectMarketOpenPlay(quotes, ct) {
  const { totalMin, isoStr, dateStr } = ct;

  // Tier 1: 8:30 AM – 10:00 AM CT only
  if (totalMin < 8 * 60 + 30 || totalMin > 10 * 60) return null;

  const spy = quotes.find(q => q.ticker === 'SPY');
  const qqq = quotes.find(q => q.ticker === 'QQQ');
  const iwm = quotes.find(q => q.ticker === 'IWM');
  if (!spy || !qqq || !iwm) return null;

  // Determine direction and confirming tickers
  const moves = [
    { ticker: 'SPY', pct: spy.changePct },
    { ticker: 'QQQ', pct: qqq.changePct },
    { ticker: 'IWM', pct: iwm.changePct },
  ];

  const bullish   = moves.filter(m => m.pct >= MIN_MOVE_PCT);
  const bearish   = moves.filter(m => m.pct <= -MIN_MOVE_PCT);
  const strongBull = moves.filter(m => m.pct >= STRONG_MOVE_PCT);
  const strongBear = moves.filter(m => m.pct <= -STRONG_MOVE_PCT);

  let direction    = null;
  let confirmers   = [];
  let movePct      = 0;
  let conviction   = 0;

  if (bullish.length >= 2 || strongBull.length >= 1) {
    direction  = 'rip';
    confirmers = bullish.map(m => m.ticker);
    movePct    = Math.max(...moves.map(m => m.pct));
    conviction = Math.min(95, 55 + Math.round(movePct * 10) + (strongBull.length >= 2 ? 10 : 0));
  } else if (bearish.length >= 2 || strongBear.length >= 1) {
    direction  = 'dump';
    confirmers = bearish.map(m => m.ticker);
    movePct    = Math.min(...moves.map(m => m.pct));
    conviction = Math.min(95, 55 + Math.round(Math.abs(movePct) * 10) + (strongBear.length >= 2 ? 10 : 0));
  }

  if (!direction) return null;

  // Cooldown check
  const cooldownKey = `${direction}-${dateStr}`;
  if (await isCoolingDown(cooldownKey, ct)) {
    console.log(`[market-intel] ${direction.toUpperCase()} suppressed by cooldown`);
    return null;
  }

  // Build signal
  const detectedAt = isoStr;
  const entryWindowClosesAt = new Date(new Date(isoStr).getTime() + ENTRY_WINDOW_MIN * 60 * 1000).toISOString();
  const status = computeSignalStatus(detectedAt, entryWindowClosesAt);

  const signal = {
    direction,
    tier: 1,
    move_pct:               parseFloat(Math.abs(movePct).toFixed(2)),
    conviction,
    confirmers:             confirmers.join(','),
    reason:                 `${confirmers.join('+')} ${direction === 'rip' ? '+' : ''}${movePct.toFixed(2)}% at open`,
    detected_at:            detectedAt,
    entry_window_closes_at: entryWindowClosesAt,
    status,
    date:                   dateStr,
    // Deduplicate by direction+date
    id:                     `${direction}-${dateStr}`,
  };

  await markCooldown(cooldownKey);
  return signal;
}

// ─── Refresh status of existing signals ───────────────────────────────────────

async function refreshSignalStatuses() {
  try {
    const rows = await dbRead('market_signals', { status: 'neq.expired' });
    for (const row of rows) {
      const newStatus = computeSignalStatus(row.detected_at, row.entry_window_closes_at);
      if (newStatus !== row.status) {
        await dbUpsert('market_signals', { ...row, status: newStatus });
      }
    }
  } catch (err) {
    console.warn('[market-intel] refreshSignalStatuses error:', err.message);
  }
}

// ─── Cleanup old signals ──────────────────────────────────────────────────────

async function cleanupOldSignals() {
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  await dbDeleteOld('market_signals', 'detected_at', cutoff);
}

// ─── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (isWeekend()) {
    return res.status(200).json({ skipped: true, reason: 'Weekend' });
  }

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const secret = req.query.secret ?? req.headers['x-cron-secret'];
  if (!isVercelCron && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ct = getCTNow();

  // Only run during market hours
  if (!isMarketHours(ct.totalMin)) {
    // Still run cleanup and status refresh even outside hours
    await cleanupOldSignals();
    return res.status(200).json({ skipped: true, reason: `Outside market hours (CT: ${ct.h}:${String(ct.m).padStart(2,'0')})` });
  }

  console.log(`[market-intel] Running — CT: ${ct.h}:${String(ct.m).padStart(2,'0')}`);

  // Step 1: Refresh status of existing signals (aging/expiry)
  await refreshSignalStatuses();

  // Step 2: Fetch live quotes for market tickers (serial — no blast)
  const quotes = [];
  for (const ticker of MARKET_TICKERS) {
    const q = await fetchLiveQuote(ticker);
    if (q) quotes.push(q);
    await sleep(200); // 200ms gap between quote fetches
  }

  if (quotes.length < 2) {
    console.warn('[market-intel] Insufficient quote data — skipping detection');
    return res.status(200).json({ ok: true, quotes: quotes.length, signalFired: false, reason: 'Insufficient data' });
  }

  // Step 3: Run RIP/DUMP detection
  let signalFired = false;
  const signal = await detectMarketOpenPlay(quotes, ct);

  if (signal) {
    const ok = await dbUpsert('market_signals', signal);
    signalFired = ok;
    console.log(`[market-intel] 🚨 ${signal.direction.toUpperCase()} detected — ${signal.reason} — conviction=${signal.conviction} — DB write: ${ok ? 'ok' : 'failed'}`);
  }

  // Step 4: Cleanup old signals every cycle
  await cleanupOldSignals();

  return res.status(200).json({
    ok:           true,
    ct_time:      `${ct.h}:${String(ct.m).padStart(2, '0')} CT`,
    quotes:       quotes.map(q => ({ ticker: q.ticker, changePct: q.changePct.toFixed(2) })),
    signalFired,
    signal:       signal ? { direction: signal.direction, conviction: signal.conviction, reason: signal.reason } : null,
  });
}
