const TICKERS = [
  'SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL',
  'MSFT', 'AMZN', 'META', 'MSTR', 'HOOD',
  'SPX', 'PLTR', 'AMD',
];

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET ?? 'helios-snapshot';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getCTWindow() {
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hour = ct.getHours();
  const min  = ct.getMinutes();
  const total = hour * 60 + min;

  if (total >= 8 * 60 + 30 && total < 11 * 60) return 'open';
  if (total >= 11 * 60 && total < 14 * 60)     return 'mid';
  if (total >= 14 * 60 && total <= 15 * 60)    return 'close';
  return null; // outside market hours — skip
}

function getCTDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function isWeekend() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const day = ct.getDay();
  return day === 0 || day === 6;
}

// ─── Polygon fetch with retry ─────────────────────────────────────────────────

async function polyFetch(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Helios-Snapshot/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429 && attempt < 3) {
      await sleep(500 * attempt);
      return polyFetch(url, attempt + 1);
    }
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ─── Fetch chain snapshot for one ticker ─────────────────────────────────────

async function fetchTickerSnapshot(symbol) {
  // Use SPX options ticker O:SPXW for SPX
  const optSym = symbol === 'SPX' ? 'SPXW' : symbol;

  // Get today's expiry for 0DTE GEX
  const today = getCTDate();

  // Fetch calls and puts snapshot
  const callsUrl = `https://api.polygon.io/v3/snapshot/options/${optSym}?contract_type=call&expiration_date=${today}&limit=250&apiKey=${POLYGON_KEY}`;
  const putsUrl  = `https://api.polygon.io/v3/snapshot/options/${optSym}?contract_type=put&expiration_date=${today}&limit=250&apiKey=${POLYGON_KEY}`;

  const [callsData, putsData] = await Promise.all([
    polyFetch(callsUrl),
    polyFetch(putsUrl),
  ]);

  const calls = callsData?.results ?? [];
  const puts  = putsData?.results  ?? [];

  // Spot price from underlying_asset
  const ua = calls[0]?.underlying_asset ?? puts[0]?.underlying_asset ?? null;
  let spot = ua?.price ?? 0;
  let spotPrevClose = ua?.day?.prev_close ?? ua?.day?.c ?? 0;
  let vwap = ua?.day?.vw ?? 0;

  // Fallback spot from Polygon quote
  if (spot <= 0) {
    const qtUrl = `https://api.polygon.io/v2/last/trade/${encodeURIComponent(symbol)}?apiKey=${POLYGON_KEY}`;
    const qt = await polyFetch(qtUrl);
    spot = qt?.results?.p ?? 0;
  }

  if (spot <= 0) return null; // no data — skip this ticker

  const spotChangePct = spotPrevClose > 0 ? ((spot - spotPrevClose) / spotPrevClose) * 100 : 0;

  // ── GEX computation ────────────────────────────────────────────────────────
  let netGEX = 0;
  let flipStrike = 0;
  let topCallWall = 0;
  let topPutWall  = 0;

  const strikeMap = new Map();

  calls.forEach(c => {
    const strike = c.details?.strike_price;
    if (!strike) return;
    const oi    = c.open_interest ?? 0;
    const gamma = c.greeks?.gamma  ?? 0;
    if (!strikeMap.has(strike)) strikeMap.set(strike, { callGEX: 0, putGEX: 0, callOI: 0, putOI: 0, callVol: 0, putVol: 0, callIV: 0, putIV: 0 });
    strikeMap.get(strike).callGEX = oi * gamma * spot * spot * 100;
    strikeMap.get(strike).callOI  = oi;
    strikeMap.get(strike).callVol = c.day?.volume ?? 0;
    strikeMap.get(strike).callIV  = c.greeks?.implied_volatility ? c.greeks.implied_volatility * 100 : 0;
  });

  puts.forEach(p => {
    const strike = p.details?.strike_price;
    if (!strike) return;
    const oi    = p.open_interest ?? 0;
    const gamma = p.greeks?.gamma  ?? 0;
    if (!strikeMap.has(strike)) strikeMap.set(strike, { callGEX: 0, putGEX: 0, callOI: 0, putOI: 0, callVol: 0, putVol: 0, callIV: 0, putIV: 0 });
    strikeMap.get(strike).putGEX = oi * gamma * spot * spot * 100;
    strikeMap.get(strike).putOI  = oi;
    strikeMap.get(strike).putVol = p.day?.volume ?? 0;
    strikeMap.get(strike).putIV  = p.greeks?.implied_volatility ? p.greeks.implied_volatility * 100 : 0;
  });

  const strikes = Array.from(strikeMap.entries()).map(([strike, d]) => ({
    strike,
    netGEX: d.callGEX - d.putGEX,
    callOI: d.callOI,
    putOI:  d.putOI,
    callVol: d.callVol,
    putVol:  d.putVol,
    callIV:  d.callIV,
    putIV:   d.putIV,
  }));

  netGEX = strikes.reduce((sum, s) => sum + s.netGEX, 0);

  // Flip strike = strike where cumulative GEX crosses zero
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  let cumGEX = 0;
  for (const s of sorted) {
    const prev = cumGEX;
    cumGEX += s.netGEX;
    if (prev < 0 && cumGEX >= 0) { flipStrike = s.strike; break; }
    if (prev > 0 && cumGEX <= 0) { flipStrike = s.strike; break; }
  }
  if (!flipStrike && sorted.length) {
    const nearSpot = sorted.filter(s => Math.abs(s.strike - spot) < spot * 0.05);
    if (nearSpot.length) {
      flipStrike = nearSpot.reduce((best, s) => Math.abs(s.netGEX) < Math.abs(best.netGEX) ? s : best).strike;
    }
  }

  // Walls: highest OI strikes above/below spot
  const aboveSpot = strikes.filter(s => s.strike > spot).sort((a, b) => b.callOI - a.callOI);
  const belowSpot = strikes.filter(s => s.strike < spot).sort((a, b) => b.putOI  - a.putOI);
  topCallWall = aboveSpot[0]?.strike ?? 0;
  topPutWall  = belowSpot[0]?.strike ?? 0;

  const gexRegime = netGEX < -1_000_000 ? 'negative' : netGEX > 1_000_000 ? 'positive' : 'neutral';

  // ── IV computation ─────────────────────────────────────────────────────────
  const atmStrikes = strikes.filter(s => Math.abs(s.strike - spot) <= spot * 0.02);
  const atmIV = atmStrikes.length > 0
    ? atmStrikes.reduce((sum, s) => sum + (s.callIV + s.putIV) / 2, 0) / atmStrikes.length
    : 0;

  const allCallIVs = strikes.map(s => s.callIV).filter(v => v > 0);
  const allPutIVs  = strikes.map(s => s.putIV).filter(v => v > 0);
  const callIVAvg  = allCallIVs.length ? allCallIVs.reduce((a, b) => a + b, 0) / allCallIVs.length : 0;
  const putIVAvg   = allPutIVs.length  ? allPutIVs.reduce((a, b) => a + b, 0)  / allPutIVs.length  : 0;
  const ivSkew     = putIVAvg - callIVAvg;

  // ── Flow aggregation ────────────────────────────────────────────────────────
  const totalCallVol = strikes.reduce((sum, s) => sum + s.callVol, 0);
  const totalPutVol  = strikes.reduce((sum, s) => sum + s.putVol,  0);
  const pcRatio      = totalCallVol > 0 ? totalPutVol / totalCallVol : 0;
  const totalCallOI  = strikes.reduce((sum, s) => sum + s.callOI, 0);
  const totalPutOI   = strikes.reduce((sum, s) => sum + s.putOI,  0);
  const pcOIRatio    = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

  // ── Max pain ────────────────────────────────────────────────────────────────
  let maxPain = spot;
  let minPain = Infinity;
  for (const s of strikes) {
    const callPain = strikes.filter(x => x.strike > s.strike).reduce((sum, x) => sum + x.callOI * (x.strike - s.strike), 0);
    const putPain  = strikes.filter(x => x.strike < s.strike).reduce((sum, x) => sum + x.putOI  * (s.strike - x.strike), 0);
    const totalPain = callPain + putPain;
    if (totalPain < minPain) { minPain = totalPain; maxPain = s.strike; }
  }

  // ── CVD from options flow — call vol = buy pressure, put vol = sell pressure ──
  // v3/trades is a STOCK endpoint — NOT available on Options Advanced plan (403).
  // We already have totalCallVol and totalPutVol from the chain fetch above.
  // This is actually MORE relevant for options traders than stock tape prints.
  const buyVolume  = totalCallVol;
  const sellVolume = totalPutVol;
  const cvd        = buyVolume - sellVolume;
  const cvdTotal   = buyVolume + sellVolume;
  const buyRatio   = cvdTotal > 0 ? buyVolume / cvdTotal : 0.5;
  const cvdTrend   = buyRatio >= 0.56 ? 'buying' : buyRatio <= 0.44 ? 'selling' : 'neutral';
  const cvdDiverging = (spotChangePct > 0.3 && cvdTrend === 'selling') ||
                       (spotChangePct < -0.3 && cvdTrend === 'buying');

  // ── IV Rank (simple — full rank computed from DB history in snapshotStore) ──
  const ivRank = 0; // placeholder — computed by snapshotStore.getRealIVRank()

  return {
    symbol,
    snapshot_date: today,
    spot:            parseFloat(spot.toFixed(4)),
    spot_change_pct: parseFloat(spotChangePct.toFixed(4)),
    vwap:            parseFloat((vwap || spot).toFixed(4)),
    net_gex:         parseFloat(netGEX.toFixed(2)),
    flip_strike:     parseFloat(flipStrike.toFixed(4)),
    top_call_wall:   parseFloat(topCallWall.toFixed(4)),
    top_put_wall:    parseFloat(topPutWall.toFixed(4)),
    gex_regime:      gexRegime,
    atm_iv:          parseFloat(atmIV.toFixed(4)),
    iv_rank:         ivRank,
    call_iv_avg:     parseFloat(callIVAvg.toFixed(4)),
    put_iv_avg:      parseFloat(putIVAvg.toFixed(4)),
    iv_skew:         parseFloat(ivSkew.toFixed(4)),
    total_call_vol:  totalCallVol,
    total_put_vol:   totalPutVol,
    pc_ratio:        parseFloat(pcRatio.toFixed(4)),
    total_call_oi:   totalCallOI,
    total_put_oi:    totalPutOI,
    pc_oi_ratio:     parseFloat(pcOIRatio.toFixed(4)),
    cvd:             parseFloat(cvd.toFixed(2)),
    buy_volume:      parseFloat(buyVolume.toFixed(2)),
    sell_volume:     parseFloat(sellVolume.toFixed(2)),
    cvd_trend:       cvdTrend,
    cvd_diverging:   cvdDiverging,
    max_pain:        parseFloat(maxPain.toFixed(4)),
    source:          'polygon-realtime',
  };
}

// ─── Save to Supabase ─────────────────────────────────────────────────────────

async function saveSnapshot(snapshot, window) {
  const row = { ...snapshot, time_of_day: window };

  const url = `${SUPABASE_URL}/rest/v1/chain_snapshots`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`[snapshot-cron] Save failed for ${snapshot.symbol}: ${res.status} ${err}`);
    return false;
  }
  return true;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check for manual trigger
  const secret = req.query.secret ?? req.headers['x-cron-secret'];
  const isVercelCron = req.headers['x-vercel-cron'] === '1';

  if (!isVercelCron && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Skip weekends
  if (isWeekend()) {
    return res.status(200).json({ skipped: true, reason: 'Weekend' });
  }

  if (!POLYGON_KEY) {
    return res.status(500).json({ error: 'POLYGON_API_KEY not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase credentials not configured' });
  }

  // Determine window
  const windowParam = req.query.window;
  const window = windowParam ?? getCTWindow();

  if (!window) {
    return res.status(200).json({ skipped: true, reason: 'Outside market hours' });
  }

  console.log(`[snapshot-cron] Starting ${window} snapshot for ${TICKERS.length} tickers`);

  const results = { saved: [], failed: [], skipped: [] };

  // Process tickers sequentially to respect rate limits
  for (const symbol of TICKERS) {
    try {
      const snapshot = await fetchTickerSnapshot(symbol);

      if (!snapshot) {
        results.skipped.push(symbol);
        console.warn(`[snapshot-cron] No data for ${symbol} — skipped`);
        continue;
      }

      const saved = await saveSnapshot(snapshot, window);
      if (saved) {
        results.saved.push(symbol);
        console.log(`[snapshot-cron] ✓ ${symbol} saved (GEX: ${snapshot.net_gex.toFixed(0)}, ATM IV: ${snapshot.atm_iv.toFixed(1)}%)`);
      } else {
        results.failed.push(symbol);
      }

      // Small delay between tickers to be gentle on rate limits
      await sleep(200);
    } catch (err) {
      results.failed.push(symbol);
      console.error(`[snapshot-cron] Error for ${symbol}:`, err?.message ?? err);
    }
  }

  console.log(`[snapshot-cron] ${window} complete — saved: ${results.saved.length}, failed: ${results.failed.length}, skipped: ${results.skipped.length}`);

  return res.status(200).json({
    window,
    date: getCTDate(),
    saved:   results.saved.length,
    failed:  results.failed.length,
    skipped: results.skipped.length,
    tickers: results,
  });
}
