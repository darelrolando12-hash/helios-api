const POLYGON_KEY  = process.env.POLYGON_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET ?? 'helios-cron';

const MARKET_TICKERS   = ['SPY', 'QQQ', 'IWM'];
const INDEX_TICKER_MAP = { SPX: 'I:SPX', NDX: 'I:NDX', VIX: 'I:VIX', SPXW: 'I:SPX' };

const MIN_MOVE_PCT    = 0.4;
const STRONG_MOVE_PCT = 0.75;
const VOLUME_MULT     = 1.2;
const COOLDOWN_MS     = 45 * 60 * 1000;
const ENTRY_WINDOW_MIN = 90;

function getCTNow() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return {
    h:        ct.getHours(),
    m:        ct.getMinutes(),
    totalMin: ct.getHours() * 60 + ct.getMinutes(),
    dateStr:  ct.toLocaleDateString('en-CA'),
    isoStr:   new Date().toISOString(),
  };
}

function isWeekend() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return ct.getDay() === 0 || ct.getDay() === 6;
}

function isMarketHours(totalMin) {
  return totalMin >= 8 * 60 && totalMin <= 15 * 60 + 5;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatCTTime(isoUtc) {
  return new Date(isoUtc).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }) + ' CT';
}

async function polyFetch(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Helios-MarketIntel/1.0' },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 429) {
      if (attempt >= 3) return null;
      await sleep(600 * attempt);
      return polyFetch(url, attempt + 1);
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

async function getDBPrevClose(symbol) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/daily_market_data?symbol=eq.${encodeURIComponent(symbol)}&order=computed_date.desc&limit=1&select=prev_close,computed_date`;
    const r = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    const rowDate = new Date(row.computed_date + 'T00:00:00');
    const ageMs = Date.now() - rowDate.getTime();
    if (ageMs > 7 * 24 * 60 * 60 * 1000) return null;
    return row.prev_close ?? null;
  } catch {
    return null;
  }
}

async function getDBAdv(symbol) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/daily_market_data?symbol=eq.${encodeURIComponent(symbol)}&order=computed_date.desc&limit=1&select=adv,computed_date`;
    const r = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0].adv ?? null;
  } catch {
    return null;
  }
}

async function fetchLiveQuote(ticker) {
  let prevClose = await getDBPrevClose(ticker);
  const adv = await getDBAdv(ticker);

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
          const liveVolume = meta.regularMarketVolume ?? 0;
          const ctNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
          const marketOpenToday = new Date(ctNow);
          marketOpenToday.setHours(8, 30, 0, 0);
          const minutesSinceOpen = Math.max(1, Math.floor((ctNow - marketOpenToday) / 60000));
          const expectedVolByNow = adv ? (adv / 390) * Math.min(minutesSinceOpen, 390) : null;
          const volumeRatio = (liveVolume > 0 && expectedVolByNow > 0)
            ? liveVolume / expectedVolByNow
            : null;
          console.log(`[market-intel] ${ticker} live=${price} prevClose=${prevClose} vol=${liveVolume} adv=${adv} volRatio=${volumeRatio?.toFixed(2) ?? 'n/a'} src=yahoo`);
          const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
          return { ticker, price, prevClose, changePct, prevVolume: liveVolume, volumeRatio };
        }
      }
    }
  } catch (e) {
    console.warn(`[market-intel] ${ticker} Yahoo failed — ${e.message}`);
  }

  if (prevClose > 0) {
    console.log(`[market-intel] ${ticker}: Yahoo unavailable, using DB prevClose=${prevClose}`);
    return { ticker, price: prevClose, prevClose, changePct: 0, prevVolume: 0, volumeRatio: null };
  }

  console.warn(`[market-intel] ${ticker}: all sources failed`);
  return null;
}

async function dbRead(table, filters) {
  const params = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
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
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
}

async function isCoolingDown(cooldownKey) {
  try {
    const rows = await dbRead('market_signal_cooldowns', { cooldown_key: `eq.${cooldownKey}` });
    if (!rows.length) return false;
    const lastFiredAt = new Date(rows[0].fired_at).getTime();
    return (Date.now() - lastFiredAt) < COOLDOWN_MS;
  } catch {
    return false;
  }
}

async function markCooldown(cooldownKey) {
  await dbUpsert('market_signal_cooldowns', {
    cooldown_key: cooldownKey,
    fired_at:     new Date().toISOString(),
  });
}

function computeSignalStatus(detectedAtIso, entryWindowClosesAtIso) {
  const now      = Date.now();
  const closesAt = new Date(entryWindowClosesAtIso).getTime();
  const msLeft   = closesAt - now;
  if (msLeft <= 0)             return 'expired';
  if (msLeft < 5 * 60 * 1000) return 'fading';
  return 'active';
}

async function detectMarketOpenPlay(quotes, ct) {
  const { totalMin, isoStr, dateStr } = ct;

  // RD-4: Window 8:30 AM – 2:15 PM CT (was 8:30–10:00 CT)
  if (totalMin < 8 * 60 + 30 || totalMin > 14 * 60 + 15) return null;

  const spy = quotes.find(q => q.ticker === 'SPY');
  const qqq = quotes.find(q => q.ticker === 'QQQ');
  const iwm = quotes.find(q => q.ticker === 'IWM');
  if (!spy || !qqq || !iwm) return null;

  const moves = [
    { ticker: 'SPY', pct: spy.changePct, vol: spy.volumeRatio ?? 1.0 },
    { ticker: 'QQQ', pct: qqq.changePct, vol: qqq.volumeRatio ?? 1.0 },
    { ticker: 'IWM', pct: iwm.changePct, vol: iwm.volumeRatio ?? 1.0 },
  ];

  // RD-3: At least one ETF must have elevated volume
  const hasVolume = moves.some(m => m.vol >= VOLUME_MULT);

  const bullish    = moves.filter(m => m.pct >= MIN_MOVE_PCT);
  const bearish    = moves.filter(m => m.pct <= -MIN_MOVE_PCT);
  const strongBull = moves.filter(m => m.pct >= STRONG_MOVE_PCT);
  const strongBear = moves.filter(m => m.pct <= -STRONG_MOVE_PCT);

  let direction  = null;
  let confirmers = [];
  let movePct    = 0;
  let conviction = 0;

  if (bullish.length >= 2 || strongBull.length >= 1) {
    direction  = 'rip';
    confirmers = bullish.map(m => m.ticker);
    movePct    = Math.max(...moves.map(m => m.pct));
    conviction = Math.min(95, 55 + Math.round(movePct * 10) + (strongBull.length >= 2 ? 10 : 0));
    if (hasVolume) conviction = Math.min(95, conviction + 8);
  } else if (bearish.length >= 2 || strongBear.length >= 1) {
    direction  = 'dump';
    confirmers = bearish.map(m => m.ticker);
    movePct    = Math.abs(Math.min(...moves.map(m => m.pct)));
    conviction = Math.min(95, 55 + Math.round(movePct * 10) + (strongBear.length >= 2 ? 10 : 0));
    if (hasVolume) conviction = Math.min(95, conviction + 8);
  }

  if (!direction) return null;

  // RD-3: Require volume confirmation — prevents gap-drift false positives
  if (!hasVolume) {
    console.log(`[market-intel] ${direction.toUpperCase()} suppressed — no volume confirmation (all ETFs < ${VOLUME_MULT}× ADV)`);
    return null;
  }

  const cooldownKey = `${direction}_market_open`;
  if (await isCoolingDown(cooldownKey)) {
    console.log(`[market-intel] ${direction.toUpperCase()} cooled down — skipping`);
    return null;
  }

  const entryWindowCloses = new Date(Date.now() + ENTRY_WINDOW_MIN * 60 * 1000).toISOString();
  const signal = {
    direction,
    tier:                   'market_open',
    ticker:                 'SPY',
    conviction,
    move_pct:               parseFloat(movePct.toFixed(2)),
    confirming_tickers:     confirmers,
    detected_at:            isoStr,
    detected_date:          dateStr,
    entry_window_closes_at: entryWindowCloses,
    status:                 'active',
    reason:                 `${direction === 'rip' ? 'Market RIP' : 'Market DUMP'}: ${confirmers.join('+')} aligned ${direction === 'rip' ? '+' : '-'}${movePct.toFixed(1)}%`,
    hold_window_minutes:    15,
    cooldown_key:           cooldownKey,
    source:                 'server-cron',
  };

  await markCooldown(cooldownKey);
  return signal;
}

async function refreshSignalStatuses() {
  try {
    const rows = await dbRead('market_signals', { 'status': 'in.(active,fading)' });
    if (!rows.length) return;
    for (const row of rows) {
      const newStatus = computeSignalStatus(row.detected_at, row.entry_window_closes_at);
      if (newStatus !== row.status) {
        await dbUpsert('market_signals', { ...row, status: newStatus });
        console.log(`[market-intel] ${row.ticker} ${row.direction} → status updated: ${row.status} → ${newStatus}`);
      }
    }
  } catch (e) {
    console.error('[market-intel] Status refresh error:', e.message);
  }
}

async function cleanupOldSignals() {
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  await dbDeleteOld('market_signals', 'detected_at', cutoff);
  const cooldownCutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  await dbDeleteOld('market_signal_cooldowns', 'fired_at', cooldownCutoff);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const secret       = req.query.secret ?? req.headers['x-cron-secret'];
  if (!isVercelCron && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (isWeekend()) {
    return res.status(200).json({ skipped: true, reason: 'Weekend' });
  }
  if (!POLYGON_KEY) {
    return res.status(500).json({ error: 'POLYGON_API_KEY not configured' });
  }

  const ct = getCTNow();

  if (!isMarketHours(ct.totalMin)) {
    await cleanupOldSignals();
    return res.status(200).json({ skipped: true, reason: `Outside market hours (CT: ${ct.h}:${String(ct.m).padStart(2,'0')})` });
  }

  console.log(`[market-intel] Running — CT: ${ct.h}:${String(ct.m).padStart(2,'0')}`);

  await refreshSignalStatuses();

  const quotes = [];
  for (const ticker of MARKET_TICKERS) {
    const q = await fetchLiveQuote(ticker);
    if (q) quotes.push(q);
    await sleep(200);
  }

  if (quotes.length < 2) {
    console.warn('[market-intel] Insufficient quote data — skipping detection');
    return res.status(200).json({ ok: true, quotes: quotes.length, signalFired: false, reason: 'Insufficient data' });
  }

  let signalFired = false;
  const signal = await detectMarketOpenPlay(quotes, ct);

  if (signal) {
    const ok = await dbUpsert('market_signals', signal);
    signalFired = ok;
    console.log(`[market-intel] 🚨 ${signal.direction.toUpperCase()} detected — ${signal.reason} — conviction=${signal.conviction} — DB write: ${ok ? 'ok' : 'failed'}`);
  }

  await cleanupOldSignals();

  return res.status(200).json({
    ok:          true,
    ct_time:     `${ct.h}:${String(ct.m).padStart(2, '0')} CT`,
    quotes:      quotes.map(q => ({ ticker: q.ticker, changePct: q.changePct.toFixed(2) })),
    signalFired,
    signal:      signal ? { direction: signal.direction, conviction: signal.conviction, reason: signal.reason } : null,
  });
}
