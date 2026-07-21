const TICKERS = [
  'SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL',
  'MSFT', 'AMZN', 'META', 'MSTR', 'HOOD',
  'SPX', 'PLTR', 'AMD',
];

const POLYGON_KEY  = process.env.POLYGON_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET ?? 'helios-snapshot';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getCTWindow() {
  const now = new Date();
  const ct  = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hour  = ct.getHours();
  const min   = ct.getMinutes();
  const total = hour * 60 + min;
  if (total >= 8 * 60 + 30 && total < 11 * 60) return 'open';
  if (total >= 11 * 60 && total < 14 * 60)     return 'mid';
  if (total >= 14 * 60 && total <= 15 * 60)    return 'close';
  return null;
}

function getCTDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function isWeekend() {
  const ct  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const day = ct.getDay();
  return day === 0 || day === 6;
}

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

async function fetchTickerSnapshot(symbol) {
  const optSym = symbol === 'SPX' ? 'SPXW' : symbol;
  const today  = getCTDate();

  const callsUrl = `https://api.polygon.io/v3/snapshot/options/${optSym}?contract_type=call&expiration_date=${today}&limit=250&apiKey=${POLYGON_KEY}`;
  const putsUrl  = `https://api.polygon.io/v3/snapshot/options/${optSym}?contract_type=put&expiration_date=${today}&limit=250&apiKey=${POLYGON_KEY}`;

  const [callsData, putsData] = await Promise.all([
    polyFetch(callsUrl),
    polyFetch(putsUrl),
  ]);

  const calls = callsData?.results ?? [];
  const puts  = putsData?.results  ?? [];

  const ua = calls[0]?.underlying_asset ?? puts[0]?.underlying_asset ?? null;
  let spot          = ua?.price ?? 0;
  let spotPrevClose = ua?.day?.prev_close ?? ua?.day?.c ?? 0;
  let vwap          = ua?.day?.vw ?? 0;

  // Yahoo fallback for spot — avoids /v2/last/trade 403 on index tickers
  if (spot <= 0) {
    const isIndexSym = symbol === 'SPX' || symbol === 'SPXW' || symbol === 'NDX';
    const yahooSym   = isIndexSym
      ? (symbol === 'NDX' ? '^NDX' : '^GSPC')
      : symbol;
    try {
      const yRes = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1m&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
      );
      if (yRes.ok) {
        const yData = await yRes.json();
        spot = yData?.chart?.result?.[0]?.meta?.regularMarketPrice ?? 0;
      }
    } catch { /* skip */ }
  }

  if (spot <= 0) return null;

  const spotChangePct = spotPrevClose > 0 ? ((spot - spotPrevClose) / spotPrevClose) * 100 : 0;

  const strikeMap = new Map();

  calls.forEach(c => {
    const strike = c.details?.strike_price;
    if (!strike) return;
    const oi    = c.open_interest ?? 0;
    const gamma = c.greeks?.gamma ?? 0;
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
    const gamma = p.greeks?.gamma ?? 0;
    if (!strikeMap.has(strike)) strikeMap.set(strike, { callGEX: 0, putGEX: 0, callOI: 0, putOI: 0, callVol: 0, putVol: 0, callIV: 0, putIV: 0 });
    strikeMap.get(strike).putGEX = oi * gamma * spot * spot * 100;
    strikeMap.get(strike).putOI  = oi;
    strikeMap.get(strike).putVol = p.day?.volume ?? 0;
    strikeMap.get(strike).putIV  = p.greeks?.implied_volatility ? p.greeks.implied_volatility * 100 : 0;
  });

  const strikes = Array.from(strikeMap.entries()).map(([strike, d]) => ({
    strike,
    netGEX:  d.callGEX - d.putGEX,
    callOI:  d.callOI,
    putOI:   d.putOI,
    callVol: d.callVol,
    putVol:  d.putVol,
    callIV:  d.callIV,
    putIV:   d.putIV,
  }));

  let netGEX = strikes.reduce((sum, s) => sum + s.netGEX, 0);

  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  let cumGEX = 0, flipStrike = 0;
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

  const aboveSpot = strikes.filter(s => s.strike > spot).sort((a, b) => b.callOI - a.callOI);
  const belowSpot = strikes.filter(s => s.strike < spot).sort((a, b) => b.putOI  - a.putOI);
  const topCallWall = aboveSpot[0]?.strike ?? 0;
  const topPutWall  = belowSpot[0]?.strike ?? 0;

  const gexRegime = netGEX < -1_000_000 ? 'negative' : netGEX > 1_000_000 ? 'positive' : 'neutral';

  const atmStrikes  = strikes.filter(s => Math.abs(s.strike - spot) <= spot * 0.02);
  const atmIV       = atmStrikes.length > 0
    ? atmStrikes.reduce((sum, s) => sum + (s.callIV + s.putIV) / 2, 0) / atmStrikes.length
    : 0;

  const allCallIVs = strikes.map(s => s.callIV).filter(v => v > 0);
  const allPutIVs  = strikes.map(s => s.putIV).filter(v => v > 0);
  const callIVAvg  = allCallIVs.length ? allCallIVs.reduce((a, b) => a + b, 0) / allCallIVs.length : 0;
  const putIVAvg   = allPutIVs.length  ? allPutIVs.reduce((a, b) => a + b, 0)  / allPutIVs.length  : 0;
  const ivSkew     = putIVAvg - callIVAvg;

  const totalCallVol = strikes.reduce((sum, s) => sum + s.callVol, 0);
  const totalPutVol  = strikes.reduce((sum, s) => sum + s.putVol,  0);
  const pcRatio      = totalCallVol > 0 ? totalPutVol / totalCallVol : 0;
  const totalCallOI  = strikes.reduce((sum, s) => sum + s.callOI, 0);
  const totalPutOI   = strikes.reduce((sum, s) => sum + s.putOI,  0);
  const pcOIRatio    = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

  let maxPain = spot, minPain = Infinity;
  for (const s of strikes) {
    const callPain  = strikes.filter(x => x.strike > s.strike).reduce((sum, x) => sum + x.callOI * (x.strike - s.strike), 0);
    const putPain   = strikes.filter(x => x.strike < s.strike).reduce((sum, x) => sum + x.putOI  * (s.strike - x.strike), 0);
    const totalPain = callPain + putPain;
    if (totalPain < minPain) { minPain = totalPain; maxPain = s.strike; }
  }

  const buyVolume  = totalCallVol;
  const sellVolume = totalPutVol;
  const cvd        = buyVolume - sellVolume;
  const cvdTotal   = buyVolume + sellVolume;
  const buyRatio   = cvdTotal > 0 ? buyVolume / cvdTotal : 0.5;
  const cvdTrend   = buyRatio >= 0.56 ? 'buying' : buyRatio <= 0.44 ? 'selling' : 'neutral';
  const cvdDiverging = (spotChangePct > 0.3 && cvdTrend === 'selling') ||
                       (spotChangePct < -0.3 && cvdTrend === 'buying');

  const ivRank = 0;

  return {
    symbol,
    snapshot_date:   today,
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret       = req.query.secret ?? req.headers['x-cron-secret'];
  const isVercelCron = req.headers['x-vercel-cron'] === '1';

  if (!isVercelCron && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (isWeekend()) {
    return res.status(200).json({ skipped: true, reason: 'Weekend' });
  }

  if (!POLYGON_KEY) {
    return res.status(500).json({ error: 'POLYGON_API_KEY not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase credentials not configured' });
  }

  const windowParam = req.query.window;
  const window      = windowParam ?? getCTWindow();

  if (!window) {
    return res.status(200).json({ skipped: true, reason: 'Outside market hours' });
  }

  console.log(`[snapshot-cron] Starting ${window} snapshot for ${TICKERS.length} tickers`);

  const results = { saved: [], failed: [], skipped: [] };

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
      await sleep(200);
    } catch (err) {
      results.failed.push(symbol);
      console.error(`[snapshot-cron] Error for ${symbol}:`, err?.message ?? err);
    }
  }

  console.log(`[snapshot-cron] ${window} complete — saved: ${results.saved.length}, failed: ${results.failed.length}, skipped: ${results.skipped.length}`);

  return res.status(200).json({
    window,
    date:    getCTDate(),
    saved:   results.saved.length,
    failed:  results.failed.length,
    skipped: results.skipped.length,
    tickers: results,
  });
}
