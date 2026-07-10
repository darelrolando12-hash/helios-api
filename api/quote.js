const POLYGON_KEY   = process.env.POLYGON_API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// ── Ticker classification ────────────────────────────────────────────────────
// VIX is ALWAYS Yahoo — no Polygon path exists on Options Advanced plan
const VIX_SYMBOLS   = new Set(['VIX', '^VIX', 'I:VIX']);
const INDEX_TICKER_MAP = { SPX: 'I:SPX', NDX: 'I:NDX', SPXW: 'I:SPX' };

function isVixTicker(ticker) {
  return VIX_SYMBOLS.has(ticker.toUpperCase());
}

function toPolygonAggTicker(ticker) {
  const up = ticker.toUpperCase();
  if (up.startsWith('^')) return up.replace('^', 'I:');
  return INDEX_TICKER_MAP[up] ?? up;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function readDBDailyData(symbol) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/daily_market_data?symbol=eq.${encodeURIComponent(symbol)}&order=date.desc&limit=1&select=*`;
    const r = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    // Reject if data is older than 7 days (truly stale — prev-day bar is valid all week)
    // NOTE: Before 4PM CT daily cron runs, DB has yesterday's data — that's perfectly valid.
    // Old 3-day threshold was causing false misses Mon morning after a cron delay.
    const rowDate = new Date(row.date + 'T00:00:00');
    const ageMs = Date.now() - rowDate.getTime();
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      console.warn(`[quote.js] DB daily_market_data stale for ${symbol} (${row.date}) — falling back to Polygon`);
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

// ── Yahoo Finance helpers ────────────────────────────────────────────────────

async function fetchYahooQuote(ticker) {
  const yahooTicker = ticker === 'SPX' ? '^GSPC'
    : ticker === 'NDX' ? '^NDX'
    : ticker === 'VIX' || ticker === '^VIX' || ticker === 'I:VIX' ? '^VIX'
    : ticker.startsWith('I:') ? '^' + ticker.slice(2)
    : ticker;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1m&range=1d`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios/3.0)', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const json = await r.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No Yahoo meta');

  const price     = meta.regularMarketPrice ?? meta.previousClose ?? 0;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
  const change    = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;

  return {
    price,
    prevClose,
    change,
    changePct,
    high:   meta.regularMarketDayHigh ?? price,
    low:    meta.regularMarketDayLow  ?? price,
    open:   meta.regularMarketOpen    ?? prevClose,
    volume: meta.regularMarketVolume  ?? 0,
    vwap:   null,
    source: 'yahoo',
  };
}

// ── Polygon spot price (stocks + non-VIX indices) ────────────────────────────
//
// RATE LIMIT ARCHITECTURE — permanent fix:
// BEFORE: 2 Polygon calls per quote (prev-day agg + live last-trade)
// AFTER:  1 Polygon call per quote (live last-trade only)
// Prev-day fields come from DB (daily-data-cron writes them at 4:05 PM CT).
// /v2/aggs/prev only fires if DB has no prev data (first-run / stale DB).
//
async function fetchPolygonSpot(ticker) {
  const aggTicker = toPolygonAggTicker(ticker);
  const sym = ticker.toUpperCase();

  // ── Step 1: Read prev-day fields from DB
  let prevClose = 0, prevVwap = 0, prevHigh = 0, prevLow = 0, prevOpen = 0, prevVol = 0;
  let prevFromDB = false;

  const dbRow = await readDBDailyData(sym);
  if (dbRow && dbRow.prev_close) {
    prevClose  = dbRow.prev_close  ?? 0;
    prevHigh   = dbRow.prev_high   ?? 0;
    prevLow    = dbRow.prev_low    ?? 0;
    prevOpen   = dbRow.prev_open   ?? 0;
    prevVwap   = dbRow.prev_vwap   ?? 0;
    prevVol    = dbRow.prev_volume ?? 0;
    prevFromDB = true;
    console.log(`[quote.js] fetchPolygonSpot ${ticker}: prev-day from DB (${dbRow.computed_date}), prevClose=${prevClose}`);
  }

  // ── Step 2: If DB miss, fall back to /v2/aggs/prev
  if (!prevFromDB) {
    try {
      const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggTicker)}/prev?adjusted=true&apiKey=${POLYGON_KEY}`;
      const prevR = await fetch(prevUrl, { headers: { 'User-Agent': 'Helios/3.0' } });
      if (prevR.ok) {
        const d = await prevR.json();
        const bar = d?.results?.[0];
        if (bar) {
          prevClose = bar.c ?? 0;
          prevVwap  = bar.vw ?? 0;
          prevHigh  = bar.h ?? 0;
          prevLow   = bar.l ?? 0;
          prevOpen  = bar.o ?? 0;
          prevVol   = bar.v ?? 0;
          console.log(`[quote.js] fetchPolygonSpot ${ticker}: prev-day from Polygon (DB miss), prevClose=${prevClose}`);
        }
      }
    } catch { /* non-blocking */ }
  }

  // ── Step 3: Live last trade — ALWAYS 1 call (real-time price)
  let livePrice = 0, liveTime = null, liveSize = null;
  try {
    const isIndex = !!INDEX_TICKER_MAP[ticker.toUpperCase()];
    const lastUrl = isIndex
      ? `https://api.polygon.io/v2/last/trade/${encodeURIComponent(aggTicker)}?apiKey=${POLYGON_KEY}`
      : `https://api.polygon.io/v2/last/stocks/${encodeURIComponent(ticker)}?apiKey=${POLYGON_KEY}`;
    const lastR = await fetch(lastUrl, { headers: { 'User-Agent': 'Helios/3.0' } });
    if (lastR.ok) {
      const ld = await lastR.json();
      livePrice = ld?.results?.p ?? ld?.last?.price ?? 0;
      liveTime  = ld?.results?.t ?? ld?.last?.timestamp ?? null;
      liveSize  = ld?.results?.s ?? ld?.last?.size ?? null;
    }
  } catch { /* non-blocking */ }

  // NOTE: Stock bid/ask spread (/v2/last/nbbo) is NOT available on the Options Advanced plan —
  // every request 403s. bid/ask/bidAskSpread for stock quotes are returned as null.
  // The options spread used for signal gating is computed in tickerSignal.ts from the ATM
  // options chain bid/ask (zero extra API calls) and does not depend on this field.

  const price = livePrice > 0 ? livePrice : prevClose;

  console.log(`[quote.js] fetchPolygonSpot ${ticker}: live=${livePrice}, prevClose=${prevClose}, using=${price}, prevSrc=${prevFromDB ? 'db' : 'polygon'}`);

  return { price, prevClose, vwap: prevVwap, high: prevHigh, low: prevLow, open: prevOpen, volume: prevVol, liveTime, liveSize,
    bid: null, ask: null, bidAskSpread: null };
}

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, type } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const sym = symbol.toUpperCase().trim();

  // ── RULE 1: VIX → always Yahoo, no Polygon path ─────────────────────────────
  if (isVixTicker(sym) && !type) {
    try {
      const q = await fetchYahooQuote(sym);
      return res.status(200).json({
        symbol:    'VIX',
        price:     q.price,
        change:    q.change,
        changePct: q.changePct,
        high:      q.high,
        low:       q.low,
        open:      q.open,
        prevClose: q.prevClose,
        volume:    q.volume,
        vwap:      null,
        bid:       null,
        ask:       null,
        bidAskSpread: null,
        source:    'yahoo-vix',
      });
    } catch (e) {
      return res.status(200).json({ symbol: 'VIX', price: 0, error: e.message, source: 'yahoo-vix-failed' });
    }
  }

  // ── Type: candles (1-min bars) ───────────────────────────────────────────────
  if (type === 'candles' || type === 'candles1m') {
    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const aggTicker = toPolygonAggTicker(sym);
      const to   = new Date();
      const from = new Date(to.getTime() - 90 * 60 * 1000); // last 90 min
      const url  = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggTicker)}/range/1/minute/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=120&apiKey=${POLYGON_KEY}`;
      const r    = await fetch(url, { headers: { 'User-Agent': 'Helios/3.0' } });
      if (!r.ok) return res.status(200).json({ symbol: sym, bars: [], error: `Polygon ${r.status}` });
      const data = await r.json();
      const rawBars = data.results ?? [];
      const bars = rawBars.map(b => ({
        time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw ?? 0,
      }));
      return res.status(200).json({ symbol: sym, bars, count: bars.length, source: 'polygon' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, bars: [], error: e.message || 'Candles failed' });
    }
  }

  // ── Type: candles5m (5-min bars) ─────────────────────────────────────────────
  if (type === 'candles5m') {
    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const aggTicker = toPolygonAggTicker(sym);
      const to   = new Date();
      const from = new Date(to.getTime() - 8 * 60 * 60 * 1000); // last 8 hours
      const url  = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggTicker)}/range/5/minute/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=120&apiKey=${POLYGON_KEY}`;
      const r    = await fetch(url, { headers: { 'User-Agent': 'Helios/3.0' } });
      if (!r.ok) return res.status(200).json({ symbol: sym, bars: [], error: `Polygon ${r.status}` });
      const data = await r.json();
      const rawBars = data.results ?? [];
      const bars = rawBars.map(b => ({
        time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw ?? 0,
      }));
      return res.status(200).json({ symbol: sym, bars, count: bars.length, source: 'polygon' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, bars: [], error: e.message || 'Candles5m failed' });
    }
  }

  // ── Type: candles15m (15-min bars) ───────────────────────────────────────────
  if (type === 'candles15m') {
    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const aggTicker = toPolygonAggTicker(sym);
      const to   = new Date();
      const from = new Date(to.getTime() - 24 * 60 * 60 * 1000); // last 24 hours
      const url  = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggTicker)}/range/15/minute/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=100&apiKey=${POLYGON_KEY}`;
      const r    = await fetch(url, { headers: { 'User-Agent': 'Helios/3.0' } });
      if (!r.ok) return res.status(200).json({ symbol: sym, bars: [], error: `Polygon ${r.status}` });
      const data = await r.json();
      const rawBars = data.results ?? [];
      const bars = rawBars.map(b => ({
        time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw ?? 0,
      }));
      return res.status(200).json({ symbol: sym, bars, count: bars.length, source: 'polygon' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, bars: [], error: e.message || 'Candles15m failed' });
    }
  }

  // ── Type: agg (ADV — 20-day average daily volume) ────────────────────────────
  // RULE 2: Read from DB first — only call Polygon if DB miss
  if (type === 'agg') {
    const isBacktest = req.query.backtest === 'true';
    if (!isBacktest) {
      const dbRow = await readDBDailyData(sym);
      if (dbRow?.adv) {
        console.log(`[quote.js] ADV for ${sym} served from DB (${dbRow.date}): ${dbRow.adv}`);
        return res.status(200).json({
          symbol: sym,
          avgDailyVolume: dbRow.adv,
          bars: 0,
          source: 'db-daily',
          date: dbRow.date,
        });
      }
    }

    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: 'No Polygon key' });
    console.log(`[quote.js] ADV for ${sym} — DB miss, falling back to Polygon`);
    try {
      const aggTicker  = toPolygonAggTicker(sym);
      const to         = new Date();
      const from       = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const multiplier = req.query.multiplier ?? 1;
      const timespan   = req.query.timespan   ?? 'day';
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggTicker)}/range/${multiplier}/${timespan}/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=50&apiKey=${POLYGON_KEY}`;
      const r   = await fetch(url, { headers: { 'User-Agent': 'Helios/3.0' } });
      if (!r.ok) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, results: [], error: `Polygon ${r.status}` });
      const data = await r.json();
      const bars = data.results ?? [];
      if (isBacktest) {
        return res.status(200).json({ symbol: sym, results: bars, count: bars.length, source: 'polygon' });
      }
      const volumes       = bars.map(b => b.v || 0);
      const avgDailyVolume = volumes.length > 0 ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length) : 0;
      return res.status(200).json({ symbol: sym, avgDailyVolume, bars: bars.length, source: 'polygon-fallback' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, avgDailyVolume: 0, results: [], error: e.message || 'ADV failed' });
    }
  }

  // ── Type: options (ATM Greeks + IV + P/C ratio) ──────────────────────────────
  if (type === 'options') {
    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    try {
      if (isVixTicker(sym)) return res.status(200).json({ symbol: sym, error: 'VIX has no options chain' });

      const { price: spot } = await fetchPolygonSpot(sym);
      if (!spot) return res.status(200).json({ symbol: sym, error: 'No spot price' });

      const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const optRes = await fetch(
        `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date.gte=${today}&limit=50&apiKey=${POLYGON_KEY}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!optRes.ok) return res.status(200).json({ symbol: sym, spot, error: `Options snapshot ${optRes.status}` });

      const optData = await optRes.json();
      const results = optData?.results ?? [];

      let atmCall = null, atmPut = null;
      let minCallDist = Infinity, minPutDist = Infinity;
      let totalCallOI = 0, totalPutOI = 0;
      let totalCallVol = 0, totalPutVol = 0;

      for (const r of results) {
        const strike = r.details?.strike_price ?? 0;
        const dist   = Math.abs(strike - spot);
        const side   = r.details?.contract_type;
        const oi     = r.open_interest ?? 0;
        const vol    = r.day?.volume ?? 0;
        if (side === 'call') { totalCallOI += oi; totalCallVol += vol; if (dist < minCallDist) { minCallDist = dist; atmCall = r; } }
        if (side === 'put')  { totalPutOI  += oi; totalPutVol  += vol; if (dist < minPutDist)  { minPutDist  = dist; atmPut  = r; } }
      }

      const callIV    = atmCall?.implied_volatility ?? atmCall?.greeks?.implied_volatility ?? null;
      const putIV     = atmPut?.implied_volatility  ?? atmPut?.greeks?.implied_volatility  ?? null;
      const callGamma = atmCall?.greeks?.gamma ?? null;
      const callTheta = atmCall?.greeks?.theta ?? null;
      const callDelta = atmCall?.greeks?.delta ?? null;
      const putDelta  = atmPut?.greeks?.delta  ?? null;
      const pcRatio   = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

      const callMid = atmCall ? ((atmCall.last_quote?.ask ?? 0) + (atmCall.last_quote?.bid ?? 0)) / 2 : 0;
      const putMid  = atmPut  ? ((atmPut.last_quote?.ask  ?? 0) + (atmPut.last_quote?.bid  ?? 0)) / 2 : 0;
      const impliedMove = spot > 0 && (callMid + putMid) > 0
        ? ((callMid + putMid) / spot * 100).toFixed(2)
        : null;

      return res.status(200).json({
        symbol: sym, spot, callIV, callDelta, callGamma, callTheta,
        putIV, putDelta, pcRatio, totalCallOI, totalPutOI,
        totalCallVol, totalPutVol, impliedMove,
        source: 'polygon-realtime',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, error: e.message || 'Options Greeks failed' });
    }
  }

  // ── Type: hv (Historical Volatility + IV Rank) ───────────────────────────────
  // RULE 3: Read from DB first — only call Polygon if DB miss
  if (type === 'hv') {
    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    if (isVixTicker(sym)) return res.status(200).json({ symbol: sym, error: 'VIX HV not supported' });

    const dbRow = await readDBDailyData(sym);
    if (dbRow && dbRow.hv20 != null) {
      console.log(`[quote.js] HV for ${sym} served from DB (${dbRow.date})`);
      return res.status(200).json({
        symbol:       sym,
        hv10:         dbRow.hv10         ?? null,
        hv20:         dbRow.hv20         ?? null,
        hv60:         dbRow.hv60         ?? null,
        hv252:        dbRow.hv252        ?? null,
        ivRank:       dbRow.iv_rank      ?? null,
        high52w:      dbRow.high_52w     ?? null,
        low52w:       dbRow.low_52w      ?? null,
        currentClose: dbRow.close        ?? null,
        totalBars:    252,
        source:       'db-daily',
        date:         dbRow.date,
      });
    }

    // DB miss — fall back to Polygon
    console.log(`[quote.js] HV for ${sym} — DB miss, falling back to Polygon 5yr fetch`);
    try {
      const to   = new Date();
      const from = new Date(to.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
      const hvSym = toPolygonAggTicker(sym);
      const hvRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(hvSym)}/range/1/day/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=1500&apiKey=${POLYGON_KEY}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!hvRes.ok) return res.status(200).json({ symbol: sym, error: `Polygon HV ${hvRes.status}` });
      const hvData = await hvRes.json();
      const bars   = hvData?.results ?? [];
      if (bars.length < 10) return res.status(200).json({ symbol: sym, error: 'Insufficient price history' });

      const closes = bars.map(b => b.c);

      function calcHV(n) {
        if (closes.length < n + 1) return null;
        const recent = closes.slice(-n - 1);
        const rets = [];
        for (let i = 1; i < recent.length; i++) {
          if (recent[i - 1] > 0) rets.push(Math.log(recent[i] / recent[i - 1]));
        }
        if (rets.length < 2) return null;
        const mean     = rets.reduce((a, b) => a + b, 0) / rets.length;
        const variance = rets.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (rets.length - 1);
        return parseFloat((Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(2));
      }

      const hv10  = calcHV(10);
      const hv20  = calcHV(20);
      const hv60  = calcHV(60);
      const hv252 = calcHV(252);

      const currentClose   = closes[closes.length - 1] ?? null;
      const high52w        = closes.length >= 252 ? Math.max(...closes.slice(-252)) : Math.max(...closes);
      const low52w         = closes.length >= 252 ? Math.min(...closes.slice(-252)) : Math.min(...closes);
      const pricePercentile = high52w > low52w
        ? Math.round(((currentClose - low52w) / (high52w - low52w)) * 100) : null;

      let ivHvRatio = null, expensiveOptions = false, cheapOptions = false;
      try {
        const optRes2 = await fetch(
          `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date.gte=${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })}&limit=10&apiKey=${POLYGON_KEY}`,
          { headers: { 'User-Agent': 'Helios/3.0' } }
        );
        if (optRes2.ok) {
          const od          = await optRes2.json();
          const firstResult = od?.results?.[0];
          const currentIV   = firstResult?.implied_volatility ?? firstResult?.greeks?.implied_volatility ?? null;
          if (currentIV && hv20) {
            ivHvRatio        = parseFloat((currentIV / hv20).toFixed(2));
            expensiveOptions = ivHvRatio > 1.3;
            cheapOptions     = ivHvRatio < 0.7;
          }
        }
      } catch { /* IV ratio is optional */ }

      const priceHistory = bars.slice(-252).map(b => ({ t: b.t, c: b.c, v: b.v }));

      return res.status(200).json({
        symbol: sym, hv10, hv20, hv60, hv252,
        ivHvRatio, expensiveOptions, cheapOptions,
        high52w, low52w, currentClose, pricePercentile,
        totalBars: bars.length, priceHistory,
        source: 'polygon-5yr-fallback',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, error: e.message || 'HV computation failed' });
    }
  }

  // ── Type: validate_contract ──────────────────────────────────────────────────
  if (type === 'validate_contract') {
    const { expiry, strike, optionType } = req.query;
    if (!expiry || !strike || !optionType) {
      return res.status(400).json({ exists: false, error: 'expiry, strike, optionType required' });
    }

    if (!POLYGON_KEY) return res.status(200).json({ exists: false, error: 'No Polygon key' });

    try {
      const occ = `O:${sym}${expiry.replace(/-/g, '').slice(2)}${optionType.toUpperCase()[0]}${(parseFloat(strike) * 1000).toString().padStart(8, '0')}`;
      const url = `https://api.polygon.io/v3/reference/options/contracts/${encodeURIComponent(occ)}?apiKey=${POLYGON_KEY}`;
      const r   = await fetch(url, { headers: { 'User-Agent': 'Helios/3.0' } });
      if (!r.ok) return res.status(200).json({ exists: false, error: `Polygon ${r.status}` });
      const json   = await r.json();
      const exists = !!json?.results;
      return res.status(200).json({ exists, occ: exists ? occ : null });
    } catch (e) {
      return res.status(200).json({ exists: false, error: e.message });
    }
  }

  // ── Default: real-time quote ─────────────────────────────────────────────────
  // RULE 4: fetchSpot is the ONLY place that calls Polygon for price data
  try {
    const q        = await fetchPolygonSpot(sym);
    const change   = q.price - q.prevClose;
    const changePct = q.prevClose > 0 ? (change / q.prevClose) * 100 : 0;

    return res.status(200).json({
      symbol:    sym,
      price:     q.price,
      change,
      changePct,
      high:      q.high,
      low:       q.low,
      open:      q.open,
      prevClose: q.prevClose,
      volume:    q.volume,
      vwap:      q.vwap,
      bid:       null,
      ask:       null,
      bidAskSpread: null,
      lastTradeSize: q.liveSize,
      lastTradeTime: q.liveTime,
      todayVolumeRatio: null,
      source:    'polygon-realtime',
    });
  } catch (e) {
    // Fallback to Yahoo if Polygon fails
    try {
      const yq = await fetchYahooQuote(sym);
      return res.status(200).json({
        symbol:    sym,
        price:     yq.price,
        change:    yq.change,
        changePct: yq.changePct,
        high:      yq.high,
        low:       yq.low,
        open:      yq.open,
        prevClose: yq.prevClose,
        volume:    yq.volume,
        vwap:      null,
        bid:       null,
        ask:       null,
        bidAskSpread: null,
        source:    'yahoo-fallback',
      });
    } catch (ye) {
      return res.status(200).json({ symbol: sym, price: 0, error: `Polygon: ${e.message}, Yahoo: ${ye.message}`, source: 'all-failed' });
    }
  }
};
