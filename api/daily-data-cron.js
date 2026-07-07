const POLYGON_KEY  = process.env.POLYGON_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET ?? 'helios-cron';

// All 24 platform tickers (matches FEED_TICKERS in tickerSignal.ts)
const ALL_TICKERS = [
  'SPY', 'QQQ', 'IWM', 'SPX', 'NDX',
  'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'META',
  'AMD', 'GOOGL', 'NFLX', 'COIN', 'PLTR', 'HOOD', 'SOFI',
  'JPM', 'BAC', 'MSTR', 'SMCI', 'GLD',
  'HYG', 'TLT',
];

// Tickers to run calibration for (subset — intraday fetch is expensive)
const CALIBRATION_TICKERS = [
  'SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMD',
  'META', 'AMZN', 'GOOGL', 'MSTR', 'IWM', 'HOOD',
];

// ─── Index ticker normalization ───────────────────────────────────────────────

const INDEX_TICKER_MAP = { SPX: 'I:SPX', NDX: 'I:NDX', VIX: 'I:VIX', SPXW: 'I:SPX' };

function toPolygonAggTicker(ticker) {
  if (ticker.startsWith('^')) return ticker.replace('^', 'I:');
  return INDEX_TICKER_MAP[ticker] ?? ticker;
}

// ─── CT time helpers ──────────────────────────────────────────────────────────

function getCTDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function isWeekend() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return ct.getDay() === 0 || ct.getDay() === 6;
}

/**
 * isMarketHours — returns true during 7:00 AM – 4:00 PM CT.
 * PERMANENT GUARD: Daily cron MUST NOT run while market is active.
 */
function isMarketHours() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const totalMinutesCT = ct.getHours() * 60 + ct.getMinutes();
  return totalMinutesCT >= 7 * 60 && totalMinutesCT < 16 * 60;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Polygon fetch with retry + 429 backoff ───────────────────────────────────

async function polyFetch(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Helios-DailyCron/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) {
      if (attempt >= 4) return null;
      const backoff = 800 * attempt;
      console.log(`[daily-cron] 429 on attempt ${attempt}, backing off ${backoff}ms`);
      await sleep(backoff);
      return polyFetch(url, attempt + 1);
    }
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ─── HV computation ────────────────────────────────────────────────────────────

function computeHV(logReturns, window) {
  if (logReturns.length < window) return null;
  const slice    = logReturns.slice(-window);
  const mean     = slice.reduce((a, b) => a + b, 0) / window;
  const variance = slice.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (window - 1);
  return parseFloat((Math.sqrt(variance * 252) * 100).toFixed(2));
}

// ─── Fetch 5yr daily bars ─────────────────────────────────────────────────────

async function fetchDailyBars(symbol, years = 5) {
  const aggSym = toPolygonAggTicker(symbol);
  const toDate  = new Date().toISOString().split('T')[0];
  const fromDate = new Date(Date.now() - years * 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggSym)}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=1500&apiKey=${POLYGON_KEY}`;
  const data = await polyFetch(url);
  if (!data?.results?.length) return [];

  return data.results.map(b => ({
    date:   new Date(b.t).toISOString().split('T')[0],
    open:   b.o,
    high:   b.h,
    low:    b.l,
    close:  b.c,
    volume: b.v,
    vwap:   b.vw ?? (b.h + b.l + b.c) / 3,
  }));
}

// ─── Compute HV + IV rank from daily bars ────────────────────────────────────

function computeHVData(symbol, bars) {
  if (bars.length < 22) return null;

  const closes = bars.map(b => b.close);
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }

  const hv10  = computeHV(logReturns, 10);
  const hv20  = computeHV(logReturns, 20);
  const hv60  = computeHV(logReturns, 60);
  const hv252 = computeHV(logReturns, 252);

  const last252Closes = closes.slice(-252);
  const high52w = Math.max(...last252Closes);
  const low52w  = Math.min(...last252Closes);
  const current = closes[closes.length - 1];
  const pricePercentile = high52w > low52w
    ? Math.round(((current - low52w) / (high52w - low52w)) * 100)
    : 50;

  const recentVols = bars.slice(-20).map(b => b.volume);
  const adv = recentVols.length > 0
    ? Math.round(recentVols.reduce((a, b) => a + b, 0) / recentVols.length)
    : 0;

  const ivValues = bars.slice(-252)
    .filter(b => b.open > 0)
    .map(b => {
      const rangePct = (b.high - b.low) / b.open;
      return rangePct * Math.sqrt(252) * 100;
    })
    .filter(v => v > 0 && v < 500);

  let ivRank = null;
  if (ivValues.length >= 20) {
    const currentIV = ivValues[ivValues.length - 1];
    const sorted = [...ivValues].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= currentIV);
    ivRank = rank >= 0
      ? Math.round((rank / sorted.length) * 100)
      : 50;
  }

  return {
    symbol: symbol.toUpperCase(),
    hv10, hv20, hv60, hv252,
    iv_rank:          ivRank,
    iv_rank_values:   ivValues.slice(-52),
    high_52w:         parseFloat(high52w.toFixed(4)),
    low_52w:          parseFloat(low52w.toFixed(4)),
    price_percentile: pricePercentile,
    adv:              adv,
    computed_date:    getCTDateStr(),
    computed_at:      new Date().toISOString(),
  };
}

// ─── Fetch 5m intraday bars for calibration ───────────────────────────────────

async function fetchIntradayBars5m(symbol, date) {
  const aggSym = toPolygonAggTicker(symbol);
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggSym)}/range/5/minute/${date}/${date}?adjusted=true&sort=asc&limit=200&apiKey=${POLYGON_KEY}`;
  const data = await polyFetch(url);
  if (!data?.results?.length) return [];

  return data.results.map(bar => {
    const ms = bar.t;
    const ctDate = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const minutesCT = ctDate.getHours() * 60 + ctDate.getMinutes();
    return {
      timestampMs: ms,
      minutesCT,
      open:   bar.o,
      high:   bar.h,
      low:    bar.l,
      close:  bar.c,
      volume: bar.v,
    };
  });
}

// ─── Session classification (CT) ─────────────────────────────────────────────

const SESSIONS = {
  MORNING:      { start: 8 * 60 + 30, end: 11 * 60 },
  MIDDAY:       { start: 11 * 60,      end: 13 * 60 + 30 },
  AFTERNOON:    { start: 13 * 60 + 30, end: 14 * 60 + 30 },
  'POWER-HOUR': { start: 14 * 60 + 30, end: 15 * 60 },
};

function classifySession(minutesCT) {
  for (const [key, w] of Object.entries(SESSIONS)) {
    if (minutesCT >= w.start && minutesCT < w.end) return key;
  }
  return null;
}

function classifyIVContext(dailyRangePct, recentRangePcts) {
  if (recentRangePcts.length < 10) return 'normal';
  const avg = recentRangePcts.reduce((a, b) => a + b, 0) / recentRangePcts.length;
  const ratio = dailyRangePct / Math.max(avg, 0.001);
  if (ratio < 0.6) return 'low';
  if (ratio < 1.3) return 'normal';
  if (ratio < 2.0) return 'high';
  return 'extreme';
}

// ─── Simulate + measure intraday signals ─────────────────────────────────────

const SIGNAL_THRESHOLD_PCT = 0.8;
const OPTIONS_MULTIPLIER   = 2.5;
const MIN_SAMPLE_SIZE      = 20;

function simulateIntradaySignals(bars, dailyBar, recentDailyBars, adv) {
  const signals = [];
  if (bars.length < 6) return signals;

  const recentRangePcts = recentDailyBars.map(b => b.open > 0 ? (b.high - b.low) / b.open : 0);
  const dailyRangePct   = dailyBar.open > 0 ? (dailyBar.high - dailyBar.low) / dailyBar.open : 0;
  const ivContext       = classifyIVContext(dailyRangePct, recentRangePcts);

  for (let i = 5; i < bars.length - 1; i++) {
    const bar = bars[i];
    const session = classifySession(bar.minutesCT);
    if (!session) continue;

    const windowBars = bars.slice(Math.max(0, i - 5), i);
    if (windowBars.length < 3) continue;
    const windowVol = windowBars.reduce((a, b) => a + b.volume, 0) / windowBars.length;

    const changePct = bar.open > 0 ? ((bar.close - bar.open) / bar.open) * 100 : 0;
    if (Math.abs(changePct) < SIGNAL_THRESHOLD_PCT) continue;

    const direction    = changePct > 0 ? 'calls' : 'puts';
    const strength     = Math.min(95, 45 + Math.round(Math.abs(changePct) * 12));
    const volumeRatio  = windowVol > 0 ? bar.volume / windowVol : 1;
    const vBoost       = volumeRatio >= 1.5 ? 1.15 : volumeRatio >= 1.2 ? 1.08 : 1.0;

    const vwapDistPct = dailyBar.vwap > 0
      ? Math.abs((bar.close - dailyBar.vwap) / dailyBar.vwap * 100)
      : 1.0;

    signals.push({
      barIndex:        i,
      minutesCT:       bar.minutesCT,
      session,
      direction,
      signalStrength:  Math.min(95, Math.round(strength * vBoost)),
      volumeRatio:     adv > 0 ? bar.volume / adv : volumeRatio,
      vwapDistancePct: vwapDistPct,
      ivContext,
      entryPrice:      bar.close,
    });
  }
  return signals;
}

function measureOutcome(signal, bars) {
  const targets = [30, 60, 90];
  const entryMin = signal.minutesCT;
  const entry    = signal.entryPrice;

  function priceAtOffset(offset) {
    const target = entryMin + offset;
    if (target >= 15 * 60) return null;
    const candidates = bars.filter(b => b.minutesCT >= target && b.minutesCT <= target + 10);
    return candidates[0]?.close ?? null;
  }

  const p30 = priceAtOffset(targets[0]);
  const p60 = priceAtOffset(targets[1]);
  const p90 = priceAtOffset(targets[2]);
  const primary = p60 ?? p30 ?? p90 ?? entry;

  const rawMove      = ((primary - entry) / entry) * 100;
  const directed     = signal.direction === 'calls' ? rawMove : -rawMove;
  const optionPnl    = directed * OPTIONS_MULTIPLIER;

  const moves = [p30, p60, p90].filter(p => p !== null).map(p => {
    const m = ((p - entry) / entry) * 100;
    return signal.direction === 'calls' ? m : -m;
  });
  const bestMove = moves.length > 0 ? Math.max(...moves) : directed;

  return {
    primaryMovePct: directed,
    bestMovePct:    bestMove,
    optionPnlProxy: optionPnl,
    isWin:          optionPnl >= 12,
    isElite:        optionPnl >= 40,
    isTarget:       optionPnl >= 25 && optionPnl < 40,
    isBase:         optionPnl >= 12 && optionPnl < 25,
    isMiss:         optionPnl < 0,
  };
}

// ─── Compute calibration priors from outcomes ────────────────────────────────

function computeCalibrationPrior(symbol, session, direction, ivContext, outcomes) {
  if (outcomes.length < MIN_SAMPLE_SIZE) return null;

  const wins   = outcomes.filter(o => o.isWin);
  const losses = outcomes.filter(o => o.isMiss);
  const elites = outcomes.filter(o => o.isElite);

  const winRate   = (wins.length   / outcomes.length) * 100;
  const eliteRate = (elites.length / outcomes.length) * 100;
  const avgGain   = wins.length   > 0 ? wins.reduce((a, o) => a + o.optionPnlProxy, 0) / wins.length : 0;
  const avgLoss   = losses.length > 0 ? losses.reduce((a, o) => a + Math.abs(o.optionPnlProxy), 0) / losses.length : 0;
  const sharpe    = avgLoss > 0 ? parseFloat((avgGain / avgLoss).toFixed(2)) : 0;

  const pnls    = outcomes.map(o => o.optionPnlProxy).sort((a, b) => a - b);
  const n       = pnls.length;
  const pctile  = (pct) => pnls[Math.min(Math.floor(n * pct), n - 1)];
  const hasTiers = n >= 25;

  const vLevels = [1.0, 1.1, 1.2, 1.3, 1.5, 1.8, 2.0];
  let bestVol = 1.3, bestVWR = 0;
  for (const t of vLevels) {
    const f = outcomes.filter(o => o.volumeRatio >= t);
    if (f.length < 5) continue;
    const wr = f.filter(o => o.isWin).length / f.length * 100;
    if (wr > bestVWR) { bestVWR = wr; bestVol = t; }
  }

  return {
    symbol,
    session,
    direction,
    iv_context:                ivContext,
    elite_rate_pct:            parseFloat(eliteRate.toFixed(1)),
    avg_gain_pct:              parseFloat(avgGain.toFixed(1)),
    win_rate_pct:              parseFloat(winRate.toFixed(1)),
    avg_loss_pct:              parseFloat(avgLoss.toFixed(1)),
    sample_size:               outcomes.length,
    sharpe_ratio:              sharpe,
    optimal_volume_multiplier: parseFloat(bestVol.toFixed(2)),
    dynamic_elite_threshold:   hasTiers ? parseFloat(pctile(0.85).toFixed(1)) : null,
    dynamic_target_threshold:  hasTiers ? parseFloat(pctile(0.65).toFixed(1)) : null,
    dynamic_base_threshold:    hasTiers ? parseFloat(pctile(0.45).toFixed(1)) : null,
    computed_date:             getCTDateStr(),
    computed_at:               new Date().toISOString(),
    source:                    'server-backtest',
  };
}

// ─── DB write helpers ─────────────────────────────────────────────────────────

async function dbUpsert(table, row, conflictCols) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        `resolution=merge-duplicates,return=minimal`,
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[daily-cron] DB upsert failed (${table}): ${res.status} ${text.slice(0, 200)}`);
    return false;
  }
  return true;
}

async function dbDelete(table, filters) {
  const params = Object.entries(filters)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  await fetch(url, {
    method:  'DELETE',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
}

// ─── Phase A: Process one ticker — HV + ADV ──────────────────────────────────

async function processHVTicker(symbol) {
  console.log(`[daily-cron] HV: processing ${symbol}`);
  const bars = await fetchDailyBars(symbol, 5);
  if (bars.length < 30) {
    console.warn(`[daily-cron] ${symbol}: only ${bars.length} daily bars — skipping HV`);
    return false;
  }

  const hvData = computeHVData(symbol, bars);
  if (!hvData) return false;

  const ok = await dbUpsert('daily_market_data', hvData, ['symbol', 'computed_date']);
  console.log(`[daily-cron] HV ${symbol}: ${ok ? '✅ saved' : '❌ failed'} — HV20=${hvData.hv20}% ADV=${hvData.adv?.toLocaleString()}`);
  return ok;
}

// ─── Phase B: Process one ticker — calibration priors ────────────────────────

async function processCalibrationTicker(symbol, allPriors) {
  console.log(`[daily-cron] CAL: processing ${symbol}`);
  const bars = await fetchDailyBars(symbol, 5);
  if (bars.length < 30) {
    console.warn(`[daily-cron] CAL ${symbol}: insufficient daily bars — skipping`);
    return;
  }

  const adv = bars.slice(-20).reduce((a, b) => a + b.volume, 0) / Math.min(20, bars.length);

  const signalDays = bars.filter((bar, i) => {
    if (i < 5) return false;
    return Math.abs((bar.close - bar.open) / bar.open * 100) >= 0.8;
  });

  const MAX_DAYS = 35;
  const step     = Math.max(1, Math.floor(signalDays.length / MAX_DAYS));
  const sample   = signalDays.filter((_, i) => i % step === 0).slice(0, MAX_DAYS);

  const allOutcomes = [];

  for (let di = 0; di < sample.length; di++) {
    const dayBar = sample[di];
    const dayIdx = bars.indexOf(dayBar);
    const recent = bars.slice(Math.max(0, dayIdx - 20), dayIdx);

    const intradayBars = await fetchIntradayBars5m(symbol, dayBar.date);
    await sleep(120);

    if (intradayBars.length < 12) {
      const pct = ((dayBar.close - dayBar.open) / dayBar.open) * 100;
      if (Math.abs(pct) >= 0.8) {
        const dir = pct > 0 ? 'calls' : 'puts';
        const opt = (dir === 'calls' ? pct : -pct) * OPTIONS_MULTIPLIER;
        const recentPcts = recent.map(b => b.open > 0 ? (b.high - b.low) / b.open : 0);
        const dailyPct   = dayBar.open > 0 ? (dayBar.high - dayBar.low) / dayBar.open : 0;
        allOutcomes.push({
          session:       'MORNING',
          direction:     dir,
          ivContext:     classifyIVContext(dailyPct, recentPcts),
          volumeRatio:   adv > 0 ? dayBar.volume / adv : 1,
          optionPnlProxy: opt,
          isWin:   opt >= 12, isElite: opt >= 40, isTarget: opt >= 25 && opt < 40,
          isBase:  opt >= 12 && opt < 25, isMiss: opt < 0,
        });
      }
      continue;
    }

    const recentPcts = recent.map(b => b.open > 0 ? (b.high - b.low) / b.open : 0);
    const dailyPct   = dayBar.open > 0 ? (dayBar.high - dayBar.low) / dayBar.open : 0;

    const sigs = simulateIntradaySignals(intradayBars, dayBar, recent, adv);
    for (const sig of sigs) {
      const outcome = measureOutcome(sig, intradayBars);
      allOutcomes.push({ ...outcome, session: sig.session, direction: sig.direction, ivContext: classifyIVContext(dailyPct, recentPcts), volumeRatio: sig.volumeRatio });
    }
  }

  const sessions   = ['MORNING', 'MIDDAY', 'AFTERNOON', 'POWER-HOUR', '*'];
  const directions = ['calls', 'puts', '*'];
  const ivContexts = ['low', 'normal', 'high', 'extreme', '*'];

  await dbDelete('calibration_priors', { symbol: symbol.toUpperCase() });

  for (const session of sessions) {
    for (const direction of directions) {
      for (const ivContext of ivContexts) {
        const matching = allOutcomes.filter(o =>
          (session   === '*' || o.session   === session) &&
          (direction === '*' || o.direction === direction) &&
          (ivContext  === '*' || o.ivContext  === ivContext),
        );
        const prior = computeCalibrationPrior(symbol, session, direction, ivContext, matching);
        if (prior) allPriors.push(prior);
      }
    }
  }

  console.log(`[daily-cron] CAL ${symbol}: ${allOutcomes.length} outcomes → ${allPriors.filter(p => p.symbol === symbol.toUpperCase()).length} priors`);
}

// ─── Phase C: Expiry dates ────────────────────────────────────────────────────

async function processExpiryTicker(symbol) {
  try {
    const optSym = symbol === 'SPX' ? 'SPXW' : symbol;
    const today  = getCTDateStr();
    const url    = `https://api.polygon.io/v3/reference/options/${encodeURIComponent(optSym)}?expiration_date.gte=${today}&limit=15&order=asc&sort=expiration_date&apiKey=${POLYGON_KEY}`;
    const data   = await polyFetch(url);
    if (!data?.results?.length) return;

    const dates = [...new Set(data.results.map(r => r.expiration_date))].sort();

    await dbUpsert('expiry_cache', {
      symbol:      symbol.toUpperCase(),
      dates:       dates,
      computed_at: new Date().toISOString(),
    }, ['symbol']);

    console.log(`[daily-cron] EXPIRY ${symbol}: ${dates.length} dates — ${dates[0]} → ${dates[dates.length - 1]}`);
  } catch (e) {
    console.error(`[daily-cron] EXPIRY ${symbol} error:`, e.message);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

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
    return res.status(200).json({ skipped: true, reason: 'Weekend — no market data today' });
  }

  // PERMANENT GUARD: never run during market hours (7AM–4PM CT)
  const manualOverride = req.query.force === 'true';
  if (isMarketHours() && !manualOverride) {
    const ctNow = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    return res.status(200).json({
      skipped: true,
      reason:  `Market hours (7AM–4PM CT) — cron blocked to protect rate limits. Current CT time: ${ctNow}. Use ?force=true to override (not recommended).`,
    });
  }
  if (!POLYGON_KEY) {
    return res.status(500).json({ error: 'POLYGON_API_KEY not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase credentials not configured' });
  }

  const startTime = Date.now();
  const phase     = req.query.phase ?? 'all';
  console.log(`[daily-cron] Starting — phase=${phase} tickers=${ALL_TICKERS.length}`);

  const results = { hv: { ok: 0, fail: 0 }, cal: { priors: 0 }, expiry: { ok: 0 }, errors: [] };

  // ── PHASE A: HV + ADV for all 24 tickers (serial, 350ms gap) ──────────────
  if (phase === 'all' || phase === 'hv') {
    console.log('[daily-cron] === Phase A: Historical Volatility + ADV ===');
    for (const sym of ALL_TICKERS) {
      try {
        const ok = await processHVTicker(sym);
        if (ok) results.hv.ok++; else results.hv.fail++;
      } catch (e) {
        results.hv.fail++;
        results.errors.push(`HV:${sym}: ${e.message}`);
      }
      await sleep(350);
    }
    console.log(`[daily-cron] Phase A done: ${results.hv.ok} ok, ${results.hv.fail} failed`);
  }

  // ── PHASE B: Calibration priors (slowest — intraday fetches) ─────────────
  if (phase === 'all' || phase === 'calibration') {
    console.log('[daily-cron] === Phase B: Backtest Calibration ===');
    const allPriors = [];
    for (const sym of CALIBRATION_TICKERS) {
      try {
        await processCalibrationTicker(sym, allPriors);
      } catch (e) {
        results.errors.push(`CAL:${sym}: ${e.message}`);
      }
      await sleep(400);
    }

    if (allPriors.length > 0) {
      for (let i = 0; i < allPriors.length; i += 50) {
        const batch = allPriors.slice(i, i + 50);
        const url = `${SUPABASE_URL}/rest/v1/calibration_priors`;
        const batchRes = await fetch(url, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer':        'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(batch),
        });
        if (!batchRes.ok) {
          const text = await batchRes.text().catch(() => '');
          console.error(`[daily-cron] Calibration batch write failed: ${batchRes.status} ${text.slice(0, 200)}`);
        }
        await sleep(50);
      }
      results.cal.priors = allPriors.length;
    }
    console.log(`[daily-cron] Phase B done: ${allPriors.length} priors written`);
  }

  // ── PHASE C: Expiry dates for all tickers (serial, 250ms gap) ─────────────
  if (phase === 'all' || phase === 'expiry') {
    console.log('[daily-cron] === Phase C: Expiry Dates ===');
    for (const sym of ALL_TICKERS) {
      try {
        await processExpiryTicker(sym);
        results.expiry.ok++;
      } catch (e) {
        results.errors.push(`EXPIRY:${sym}: ${e.message}`);
      }
      await sleep(250);
    }
    console.log(`[daily-cron] Phase C done: ${results.expiry.ok} tickers`);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`[daily-cron] ✅ Complete in ${elapsed}s — HV: ${results.hv.ok}, Priors: ${results.cal.priors}, Expiry: ${results.expiry.ok}`);

  return res.status(200).json({
    ok:       true,
    phase,
    elapsed_s: elapsed,
    date:     getCTDateStr(),
    results,
  });
}
