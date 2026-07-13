const POLYGON_KEY  = process.env.POLYGON_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// ── Ticker classification ────────────────────────────────────────────────────
// VIX is ALWAYS Yahoo — no Polygon path exists on Options Advanced plan
const VIX_SYMBOLS     = new Set(['VIX', '^VIX', 'I:VIX']);
const INDEX_TICKER_MAP = { SPX: 'I:SPX', NDX: 'I:NDX', SPXW: 'I:SPX' };

function isVixTicker(ticker) {
  return VIX_SYMBOLS.has(ticker?.toUpperCase?.());
}

function normalizeSymbol(symbol) {
  if (!symbol) return 'SPY';
  const upper = symbol.toUpperCase().trim();
  return INDEX_TICKER_MAP[upper] || upper;
}

function isIndex(symbol) {
  const norm = normalizeSymbol(symbol);
  return norm.startsWith('I:');
}

function toPolygonAggTicker(symbol) {
  const norm = normalizeSymbol(symbol);
  if (norm.startsWith('I:')) return norm;
  return symbol.toUpperCase();
}

// ── Yahoo Finance fallback ───────────────────────────────────────────────────
async function fetchYahooQuote(symbol) {
  const sym = symbol.toUpperCase();
  const yahooSym = sym === 'SPX' || sym === 'SPXW' ? '^GSPC' : (sym === 'VIX' ? '^VIX' : sym);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=5d`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Helios-quote/3.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No Yahoo result');
    const meta  = result.meta;
    const price = meta.regularMarketPrice ?? 0;
    const prev  = meta.chartPreviousClose ?? price;
    const change = price - prev;
    const changePct = prev !== 0 ? (change / prev) * 100 : 0;
    return {
      symbol:    sym,
      price:     price,
      change:    change,
      changePct: changePct,
      high:      meta.regularMarketDayHigh  || price,
      low:       meta.regularMarketDayLow   || price,
      open:      meta.regularMarketOpen     || price,
      prevClose: prev,
      volume:    meta.regularMarketVolume   || 0,
      source:    'yahoo-finance',
    };
  } catch (e) {
    throw new Error(`Yahoo fetch failed: ${e.message}`);
  }
}

// ── DB-first paths (daily_market_data) ───────────────────────────────────────
async function readDBDailyData(symbol) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/daily_market_data?symbol=eq.${encodeURIComponent(symbol.toUpperCase())}&select=*&order=computed_date.desc&limit=1`;
    const r = await fetch(url, {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0] || null;
  } catch (e) {
    console.warn(`[quote.js] readDBDailyData(${symbol}) failed: ${e.message}`);
    return null;
  }
}

// ── Polygon: spot price (last trade or prev close from /v2/aggs/prev) ───────
async function fetchPolygonSpot(symbol) {
  if (!POLYGON_KEY) return null;
  const norm = normalizeSymbol(symbol);

  // RULE 1: VIX always uses Yahoo (Polygon I:VIX → 403)
  if (isVixTicker(symbol)) {
    try {
      const q = await fetchYahooQuote('VIX');
      return {
        price:     q.price,
        prevClose: q.prevClose,
        high:      q.high,
        low:       q.low,
        open:      q.open,
        volume:    q.volume,
        vwap:      null,
        liveSize:  null,
        liveTime:  null,
      };
    } catch (e) {
      return null;
    }
  }

  // SPX → Yahoo (Polygon I:SPX daily bars 403 on Options Advanced)
  if (norm === 'I:SPX') {
    try {
      const q = await fetchYahooQuote('SPX');
      return {
        price:     q.price,
        prevClose: q.prevClose,
        high:      q.high,
        low:       q.low,
        open:      q.open,
        volume:    q.volume,
        vwap:      null,
        liveSize:  null,
        liveTime:  null,
      };
    } catch (e) {
      return null;
    }
  }

  // DB-first prev-day data (prevClose, prevHigh, prevLow)
  const dbRow = await readDBDailyData(symbol);
  const prevClose = dbRow?.prev_close ?? null;
  const prevHigh  = dbRow?.prev_high  ?? null;
  const prevLow   = dbRow?.prev_low   ?? null;

  try {
    let livePrice = null;
    let liveSize  = null;
    let liveTime  = null;

    // RULE 5: Index → /v2/last/trade/I:XXX, Equity → /v2/last/stocks/{ticker}
    const endpoint = isIndex(norm)
      ? `https://api.polygon.io/v2/last/trade/${encodeURIComponent(norm)}?apiKey=${POLYGON_KEY}`
      : `https://api.polygon.io/v2/last/trade/${encodeURIComponent(norm)}?apiKey=${POLYGON_KEY}`;

    const r = await fetch(endpoint, {
      headers: { 'User-Agent': 'Helios/3.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (r.ok) {
      const data = await r.json();
      const last = data?.results;
      if (last?.p) {
        livePrice = last.p;
        liveSize  = last.s || null;
        liveTime  = last.t || null;
      }
    }

    // If no live tick, use prevClose from DB (if available)
    const finalPrice = livePrice ?? prevClose;
    if (!finalPrice) return null;

    return {
      price:     finalPrice,
      prevClose: prevClose,
      prevHigh:  prevHigh,
      prevLow:   prevLow,
      high:      null,
      low:       null,
      open:      null,
      volume:    null,
      vwap:      null,
      liveSize:  liveSize,
      liveTime:  liveTime,
    };
  } catch (e) {
    console.warn(`[quote.js] fetchPolygonSpot(${symbol}) error: ${e.message}`);
    return null;
  }
}

// ── Type handlers ────────────────────────────────────────────────────────────

async function handleCandles(req, res, sym, multiplier, timespan) {
  if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, results: [], error: 'No Polygon key' });
  try {
    const norm = normalizeSymbol(sym);
    const aggTicker = norm.startsWith('I:') ? norm : sym.toUpperCase();
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggTicker)}/range/${multiplier}/${timespan}?adjusted=true&sort=desc&limit=90&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Helios/3.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(200).json({ symbol: sym, results: [], error: `Polygon HTTP ${r.status}` });
    const data = await r.json();
    return res.status(200).json({
      symbol: sym,
      results: data.results || [],
      count:   data.resultsCount || 0,
      source:  'polygon',
    });
  } catch (e) {
    return res.status(200).json({ symbol: sym, results: [], error: e.message || 'Candle fetch failed' });
  }
}

async function handleCandlesFormatted(req, res, sym, multiplier, timespan, limit = 90) {
  if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
  try {
    const norm = normalizeSymbol(sym);
    const aggTicker = norm.startsWith('I:') ? norm : sym.toUpperCase();
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(aggTicker)}/range/${multiplier}/${timespan}?adjusted=true&sort=desc&limit=${limit}&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Helios/3.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(200).json({ symbol: sym, bars: [], error: `Polygon HTTP ${r.status}` });
    const data = await r.json();
    const results = data.results || [];
    const bars = results.map(b => ({
      time:   b.t,
      open:   b.o,
      high:   b.h,
      low:    b.l,
      close:  b.c,
      volume: b.v || 0,
      vwap:   b.vw || null,
    }));
    return res.status(200).json({
      symbol: sym,
      bars,
      count:  bars.length,
      source: 'polygon',
    });
  } catch (e) {
    return res.status(200).json({ symbol: sym, bars: [], error: e.message || 'Candle fetch failed' });
  }
}

async function handleAgg(req, res, sym) {
  const isBacktest = req.query.backtest === 'true';

  // DB-first path: if ADV exists in daily_market_data, return it immediately (unless backtest mode)
  if (!isBacktest) {
    const dbRow = await readDBDailyData(sym);
    if (dbRow?.adv != null) {
      return res.status(200).json({ symbol: sym, avgDailyVolume: dbRow.adv, bars: 0, source: 'db' });
    }
  }

  // Fallback: call Polygon (or return raw bar array for backtest)
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

async function handleHV(req, res, sym) {
  // DB-first: if HV exists in daily_market_data, return it immediately
  const dbRow = await readDBDailyData(sym);
  if (dbRow?.hv20 != null) {
    return res.status(200).json({
      symbol: sym,
      hv10:   dbRow.hv10   ?? null,
      hv20:   dbRow.hv20   ?? null,
      hv60:   dbRow.hv60   ?? null,
      hv252:  dbRow.hv252  ?? null,
      source: 'db',
    });
  }

  // DB miss — return empty (client should never hit this after cron runs)
  console.warn(`[quote.js] HV DB miss for ${sym} — cron hasn't populated daily_market_data yet`);
  return res.status(200).json({
    symbol: sym,
    hv10:   null,
    hv20:   null,
    hv60:   null,
    hv252:  null,
    source: 'db-miss',
  });
}

async function handleOptions(req, res, sym) {
  if (!POLYGON_KEY) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
  try {
    const norm = normalizeSymbol(sym);
    const ticker = norm.startsWith('I:') ? norm : sym.toUpperCase();
    const snapshotUrl = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(ticker)}?limit=250&apiKey=${POLYGON_KEY}`;
    const r = await fetch(snapshotUrl, {
      headers: { 'User-Agent': 'Helios/3.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(200).json({ symbol: sym, error: `Polygon ${r.status}` });
    const data = await r.json();
    const results = data.results || [];
    if (results.length === 0) return res.status(200).json({ symbol: sym, error: 'No options data' });

    const atmCall = results
      .filter(c => c.details?.contract_type === 'call' && c.greeks?.delta)
      .sort((a, b) => Math.abs(a.greeks.delta - 0.5) - Math.abs(b.greeks.delta - 0.5))[0];

    const atmPut = results
      .filter(c => c.details?.contract_type === 'put' && c.greeks?.delta)
      .sort((a, b) => Math.abs(a.greeks.delta + 0.5) - Math.abs(b.greeks.delta + 0.5))[0];

    const calls = results.filter(c => c.details?.contract_type === 'call');
    const puts  = results.filter(c => c.details?.contract_type === 'put');
    const totalCallVol = calls.reduce((sum, c) => sum + (c.day?.volume || 0), 0);
    const totalPutVol  = puts.reduce((sum, c) => sum + (c.day?.volume || 0), 0);
    const pcRatio = totalCallVol > 0 ? totalPutVol / totalCallVol : null;

    const atmIV = atmCall?.implied_volatility || atmPut?.implied_volatility || null;

    return res.status(200).json({
      symbol: sym,
      atmIV,
      atmCallDelta: atmCall?.greeks?.delta || null,
      atmPutDelta:  atmPut?.greeks?.delta  || null,
      atmCallGamma: atmCall?.greeks?.gamma || null,
      atmPutGamma:  atmPut?.greeks?.gamma  || null,
      pcRatio,
      source: 'polygon',
    });
  } catch (e) {
    return res.status(200).json({ symbol: sym, error: e.message || 'Options fetch failed' });
  }
}

async function handleValidateContract(req, res, sym, expiry, strike, optionType) {
  try {
    const yahooSym = sym.toUpperCase();
    const expiryStr = expiry.replace(/-/g, '');
    const strikeInt = Math.round(parseFloat(strike) * 1000);
    const contractSuffix = `${expiryStr}${optionType === 'call' ? 'C' : 'P'}${String(strikeInt).padStart(8, '0')}`;
    const contractSymbol = `${yahooSym}${contractSuffix}`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${contractSymbol}?interval=1d&range=1d`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Helios-ValidateContract/3.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      return res.status(200).json({ exists: false, contractSymbol, error: `Yahoo HTTP ${r.status}` });
    }
    const data = await r.json();
    const hasData = data?.chart?.result?.[0]?.meta?.regularMarketPrice != null;
    return res.status(200).json({ exists: hasData, contractSymbol, source: 'yahoo' });
  } catch (e) {
    return res.status(200).json({ exists: false, error: e.message || 'Validation timeout' });
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sym  = req.query.symbol || 'SPY';
  const type = req.query.type   || 'quote';

  if (type === 'candles') {
    return handleCandles(req, res, sym, 1, 'minute');
  }
  if (type === 'candles1m') {
    return handleCandlesFormatted(req, res, sym, 1, 'minute', 90);
  }
  if (type === 'candles5m') {
    return handleCandlesFormatted(req, res, sym, 5, 'minute', 96);
  }
  if (type === 'candles15m') {
    return handleCandlesFormatted(req, res, sym, 15, 'minute', 96);
  }
  if (type === 'agg') {
    return handleAgg(req, res, sym);
  }
  if (type === 'hv') {
    return handleHV(req, res, sym);
  }
  if (type === 'options') {
    return handleOptions(req, res, sym);
  }
  if (type === 'validate_contract') {
    const expiry     = req.query.expiry;
    const strike     = req.query.strike;
    const optionType = req.query.optionType;
    if (!expiry || !strike || !optionType) {
      return res.status(400).json({ error: 'Missing expiry/strike/optionType' });
    }
    return handleValidateContract(req, res, sym, expiry, strike, optionType);
  }

  // Default: live quote (Polygon primary, Yahoo fallback)
  try {
    const spot = await fetchPolygonSpot(sym);
    if (!spot.price) {
      const q = await fetchYahooQuote(sym);
      return res.status(200).json({ ...q, symbol: sym, bid: null, ask: null, lastTradeSize: null, lastTradeTime: null });
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
      source:        spot.price === spot.prevClose ? 'polygon-prev-close' : 'polygon-realtime',
      partialCandle: false,
    });
  } catch (err) {
    try {
      const q = await fetchYahooQuote(sym);
      return res.status(200).json({ ...q, symbol: sym, bid: null, ask: null, lastTradeSize: null, lastTradeTime: null });
    } catch (ye) {
      return res.status(200).json({ symbol: sym, price: 0, error: `Both Polygon and Yahoo failed: ${ye.message}` });
    }
  }
};
