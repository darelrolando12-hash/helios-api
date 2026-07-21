const POLYGON_KEY  = process.env.POLYGON_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// ── Ticker classification ────────────────────────────────────────────────────
// VIX is ALWAYS Yahoo — no Polygon path exists on Options Advanced plan
const VIX_SYMBOLS     = new Set(['VIX', '^VIX', 'I:VIX']);
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
    // IMPORTANT: sort by computed_date (the actual column — there is no 'date' column)
    const url = `${SUPABASE_URL}/rest/v1/daily_market_data?symbol=eq.${encodeURIComponent(symbol)}&order=computed_date.desc&limit=1&select=*`;
    const r = await fetch(url, {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    // Reject if data is older than 7 days (use computed_date — the only date column on this table)
    const rowDate = new Date(row.computed_date + 'T00:00:00');
    const ageMs   = Date.now() - rowDate.getTime();
    if (ageMs > 7 * 24 * 60 * 60 * 1000) {
      console.warn(`[quote.js] DB daily_market_data stale for ${symbol} (${row.computed_date}) — falling back to Polygon`);
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

// ── Yahoo Finance helpers ────────────────────────────────────────────────────

async function fetchYahooQuote(ticker) {
  const yahooTicker = ticker === 'SPX'  ? '^GSPC'
    : ticker === 'NDX'                  ? '^NDX'
    : ticker === 'VIX' || ticker === '^VIX' || ticker === 'I:VIX' ? '^VIX'
    : ticker.startsWith('I:')           ? '^' + ticker.slice(2)
    : ticker;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1m&range=1d`;
  const r   = await fetch(url, {
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

// ── Live quote — Yahoo-first for ALL tickers ─────────────────────────────────
//
// PERMANENT RATE LIMIT FIX:
//   /v2/last/stocks/{ticker} and /v2/aggs/ticker/{sym}/prev are Stocks Basic endpoints.
//   This account is on Stocks Basic (5 req/min) — ANY call to these endpoints 403s instantly.
//   Yahoo Finance provides live price + prevClose + high/low/open/volume in one call,
//   zero Polygon budget spent, works for all tickers including equities, indices, and ETFs.
//
//   DB overlay: daily cron writes prev-day OHLCV at 4:05 PM CT — used to enrich the Yahoo
//   response with more precise prev-day fields when available.
//
async function fetchSpot(ticker) {
  const sym = ticker.toUpperCase();

  // ── Step 1: DB prev-day overlay (written by daily cron at 4:05 PM CT)
  // Provides precise prev-day OHLCV — more accurate than Yahoo's intraday meta fields.
  let prevClose = 0, prevHigh = 0, prevLow = 0, prevOpen = 0, prevVwap = 0, prevVol = 0;
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
    console.log(`[quote.js] fetchSpot ${ticker}: prev-day from DB (${dbRow.computed_date}), prevClose=${prevClose}`);
  }

  // ── Step 2: Yahoo Finance for live price + any missing prev-day fields
  // Works for equities (AAPL → AAPL), ETFs (SPY → SPY), and indices (SPX → ^GSPC).
  // Replaces /v2/last/stocks AND /v2/aggs/prev — zero Stocks Basic calls.
  try {
    const yq = await fetchYahooQuote(sym);
    if (yq && yq.price > 0) {
      // Fill any prev-day gaps from Yahoo if DB missed
      if (!prevFromDB) {
        prevClose = yq.prevClose ?? 0;
        prevHigh  = yq.high      ?? 0;
        prevLow   = yq.low       ?? 0;
        prevOpen  = yq.open      ?? 0;
        prevVol   = yq.volume    ?? 0;
      }
      console.log(`[quote.js] fetchSpot ${ticker}: live=${yq.price}, prevClose=${prevClose}, src=${prevFromDB ? 'yahoo+db' : 'yahoo'}`);
      return {
        price:     yq.price,
        prevClose: prevClose || yq.prevClose || yq.price,
        vwap:      prevVwap,
        high:      prevFromDB ? prevHigh : (yq.high ?? 0),
        low:       prevFromDB ? prevLow  : (yq.low  ?? 0),
        open:      prevFromDB ? prevOpen : (yq.open ?? 0),
        volume:    prevFromDB ? prevVol  : (yq.volume ?? 0),
        liveTime:  null,
        liveSize:  null,
      };
    }
  } catch (e) {
    console.warn(`[quote.js] fetchSpot ${ticker}: Yahoo failed — ${e.message}`);
  }

  // ── Step 3: DB-only fallback (market closed, Yahoo unavailable)
  if (prevClose > 0) {
    console.log(`[quote.js] fetchSpot ${ticker}: Yahoo unavailable, using DB prevClose=${prevClose}`);
    return { price: prevClose, prevClose, vwap: prevVwap, high: prevHigh, low: prevLow, open: prevOpen, volume: prevVol, liveTime: null, liveSize: null };
  }

  console.warn(`[quote.js] fetchSpot ${ticker}: all sources failed`);
  return { price: 0, prevClose: 0, vwap: 0, high: 0, low: 0, open: 0, volume: 0, liveTime: null, liveSize: null };
}

// Keep fetchPolygonSpot as an alias so existing internal callers (type=options) still work
const fetchPolygonSpot = fetchSpot;

// ── Candle fetch helper ───────────────────────────────────────────────────────
// Returns bars in the normalised shape { time, open, high, low, close, volume, vwap }
// that centralDataStore._fetchCandles1m() / 15m expect.

async function fetchCandleBars(sym, multiplier, timespan, fromMs, toMs, limit) {
  const aggTicker = toPolygonAggTicker(sym);
  const fromDate  = new Date(fromMs).toISOString().split('T')[0];
  const toDate    = new Date(toMs).toISOString().split('T')[0];
  const url       = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggTicker)}/range/${multiplier}/${timespan}/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=${limit}&apiKey=${POLYGON_KEY}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Helios/3.0' } });
  if (!r.ok) throw new Error(`Polygon ${r.status}`);
  const data    = await r.json();
  const rawBars = data.results ?? [];
  const bars    = rawBars.map(b => ({
    time:   b.t,
    open:   b.o,
    high:   b.h,
    low:    b.l,
    close:  b.c,
    volume: b.v,
    vwap:   b.vw ?? 0,
  }));
  return bars;
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
        source:    'yahoo-vix',
      });
    } catch (e) {
      return res.status(200).json({ symbol: 'VIX', price: 0, error: e.message, source: 'yahoo-vix-failed' });
    }
  }

  // ── Type: candles (legacy — 1-min bars, raw results[] shape) ─────────────────
  if (type === 'candles') {
    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, results: [], error: 'No Polygon key' });
    try {
      const now  = Date.now();
      const bars = await fetchCandleBars(sym, 1, 'minute', now - 90 * 60 * 1000, now, 120);
      // Legacy shape: results[] with raw polygon field names
      const results = bars.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, vw: b.vwap }));
      return res.status(200).json({ symbol: sym, results, count: results.length, source: 'polygon' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, results: [], error: e.message || 'Candles failed' });
    }
  }

  // ── Type: candles1m (1-min bars — bars[] shape for centralDataStore) ──────────
  if (type === 'candles1m') {
    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const now  = Date.now();
      const bars = await fetchCandleBars(sym, 1, 'minute', now - 90 * 60 * 1000, now, 120);
      return res.status(200).json({ symbol: sym, bars, count: bars.length, source: 'polygon' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, bars: [], error: e.message || 'Candles1m failed' });
    }
  }

  // ── Type: candles5m (5-min bars — bars[] shape for centralDataStore) ──────────
  if (type === 'candles5m') {
    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const now  = Date.now();
      const bars = await fetchCandleBars(sym, 5, 'minute', now - 8 * 60 * 60 * 1000, now, 120);
      return res.status(200).json({ symbol: sym, bars, count: bars.length, source: 'polygon' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, bars: [], error: e.message || 'Candles5m failed' });
    }
  }

  // ── Type: candles15m (15-min bars — bars[] shape for centralDataStore) ─────────
  if (type === 'candles15m') {
    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const now  = Date.now();
      const bars = await fetchCandleBars(sym, 15, 'minute', now - 24 * 60 * 60 * 1000, now, 100);
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
          symbol:         sym,
          avgDailyVolume: dbRow.adv,
          bars:           0,
          source:         'db-daily',
          date:           dbRow.date,
        });
      }
    }

    if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: 'No Polygon key' });
    console.log(`[quote.js] ADV for ${sym} — ${isBacktest ? 'backtest mode (raw bars)' : 'DB miss'}, calling Polygon`);
    try {
      const aggTicker  = toPolygonAggTicker(sym);
      const multiplier = req.query.multiplier ?? 1;
      const timespan   = req.query.timespan   ?? 'day';
      // Respect caller's from/to when provided (backtest needs multi-year range).
      // Default to last 30 days for ADV-only callers.
      const defaultTo   = new Date();
      const defaultFrom = new Date(defaultTo.getTime() - 30 * 24 * 60 * 60 * 1000);
      const fromStr = req.query.from || defaultFrom.toISOString().split('T')[0];
      const toStr   = req.query.to   || defaultTo.toISOString().split('T')[0];
      // Backtest can request up to 5 years × 252 bars; cap limit at 1500 to match cron
      const limit = isBacktest ? 1500 : 50;
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggTicker)}/range/${multiplier}/${timespan}/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=${limit}&apiKey=${POLYGON_KEY}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Helios/3.0' } });
      if (!r.ok) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, results: [], error: `Polygon ${r.status}` });
      const data = await r.json();
      const bars = data.results ?? [];
      if (isBacktest) {
        return res.status(200).json({ symbol: sym, results: bars, count: bars.length, source: 'polygon' });
      }
      const volumes        = bars.map(b => b.v || 0);
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
      const optData  = await optRes.json();
      const results  = optData?.results ?? [];

      let atmCall = null, atmPut = null;
      let minCallDist = Infinity, minPutDist = Infinity;
      let totalCallOI = 0, totalPutOI = 0;
      let totalCallVol = 0, totalPutVol = 0;

      for (const r of results) {
        const strike = r.details?.strike_price ?? 0;
        const dist   = Math.abs(strike - spot);
        const side   = r.details?.contract_type;
        const oi     = r.open_interest ?? 0;
        const vol    = r.day?.volume   ?? 0;
        if (side === 'call') {
          totalCallOI  += oi;
          totalCallVol += vol;
          if (dist < minCallDist) { minCallDist = dist; atmCall = r; }
        }
        if (side === 'put') {
          totalPutOI  += oi;
          totalPutVol += vol;
          if (dist < minPutDist) { minPutDist = dist; atmPut = r; }
        }
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
        hv10:         dbRow.hv10    ?? null,
        hv20:         dbRow.hv20    ?? null,
        hv60:         dbRow.hv60    ?? null,
        hv252:        dbRow.hv252   ?? null,
        ivRank:       dbRow.iv_rank ?? null,
        high52w:      dbRow.high_52w ?? null,
        low52w:       dbRow.low_52w  ?? null,
        currentClose: dbRow.close   ?? null,
        totalBars:    252,
        source:       'db-daily',
        date:         dbRow.date,
      });
    }

    // DB miss — fall back to Polygon 5yr fetch
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
        const rets   = [];
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

  // ── Type: validate_contract (Yahoo Finance existence check) ─────────────────
  if (type === 'validate_contract') {
    const { expiry, strike, optionType } = req.query;
    if (!expiry || !strike || !optionType) {
      return res.status(400).json({ error: 'expiry, strike, optionType required' });
    }
    try {
      const expiryDate = new Date(expiry + 'T12:00:00Z');
      const expiryUnix = Math.floor(expiryDate.getTime() / 1000);
      const yahooChain = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}?date=${expiryUnix}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios/3.0)', Accept: 'application/json' } }
      );
      if (!yahooChain.ok) return res.status(200).json({ exists: false, source: 'yahoo-delayed' });
      const chainData = await yahooChain.json();
      const chain     = chainData?.optionChain?.result?.[0];
      if (!chain) return res.status(200).json({ exists: false, source: 'yahoo-delayed' });

      const targetStrike = parseFloat(strike);
      const contracts    = optionType === 'call'
        ? (chain.options?.[0]?.calls ?? [])
        : (chain.options?.[0]?.puts  ?? []);
      const match = contracts.find(c => Math.abs(c.strike - targetStrike) < 0.01);

      return res.status(200).json({
        exists:            !!match,
        strike:            match?.strike          ?? targetStrike,
        expiry,
        optionType,
        bid:               match?.bid             ?? null,
        ask:               match?.ask             ?? null,
        lastPrice:         match?.lastPrice       ?? null,
        openInterest:      match?.openInterest    ?? null,
        impliedVolatility: match?.impliedVolatility ?? null,
        source:            'yahoo-delayed',
      });
    } catch (e) {
      return res.status(200).json({ exists: false, error: e.message, source: 'yahoo-validate-failed' });
    }
  }

  // ── Main quote — Yahoo-first for ALL tickers ────────────────────────────────
  try {
    const spot = await fetchSpot(sym);
    if (!spot.price) {
      return res.status(200).json({ symbol: sym, price: 0, error: 'All price sources failed', source: 'failed' });
    }

    const price     = spot.price;
    const prevClose = spot.prevClose || price;
    const change    = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return res.status(200).json({
      symbol:        sym,
      price,
      change,
      changePct,
      high:          spot.high   || price,
      low:           spot.low    || price,
      open:          spot.open   || prevClose,
      prevClose,
      prevHigh:      spot.high   || null,
      prevLow:       spot.low    || null,
      volume:        spot.volume || 0,
      vwap:          spot.vwap   || null,
      bid:           null,
      ask:           null,
      lastTradeSize: spot.liveSize,
      lastTradeTime: spot.liveTime,
      source:        'yahoo',
      partialCandle: false,
    });
  } catch (err) {
    return res.status(200).json({ symbol: sym, price: 0, error: `Quote failed: ${err.message}` });
  }
};
