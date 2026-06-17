module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, type } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const sym = symbol.toUpperCase().trim();
  const polygonKey = process.env.POLYGON_API_KEY;

  // ── Intraday candles (last 60 × 1-min bars — real-time) ──────────────────────
  if (type === 'candles') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 60 * 60 * 1000);
      const candleRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/minute/${from.toISOString()}/${now.toISOString()}?adjusted=true&sort=asc&limit=60&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!candleRes.ok) return res.status(200).json({ symbol: sym, bars: [], error: `Polygon ${candleRes.status}` });
      const data = await candleRes.json();
      const bars = (data?.results ?? []).map(b => ({
        time: new Date(b.t).toISOString(),
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      }));
      return res.status(200).json({ symbol: sym, bars, count: bars.length, source: 'polygon-realtime', resolution: '1min' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, bars: [], error: e.message || 'Candles failed' });
    }
  }

  // ── 20-day ADV (average daily volume) ────────────────────────────────────────
  if (type === 'agg') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: 'No Polygon key' });
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const aggRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=30&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!aggRes.ok) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: `Polygon ${aggRes.status}` });
      const data = await aggRes.json();
      const bars = data?.results ?? [];
      if (!bars.length) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, bars: 0 });
      const volumes = bars.map(b => b.v || 0);
      const avgDailyVolume = Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length);
      return res.status(200).json({ symbol: sym, avgDailyVolume, bars: bars.length, source: 'polygon' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: e.message || 'ADV failed' });
    }
  }

  // ── ATM Options Greeks (IV, delta, gamma, theta, P/C ratio) ─────────────────
  if (type === 'options') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    try {
      const snapshotRes = await fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      const snapshotData = snapshotRes.ok ? await snapshotRes.json() : null;
      const spot = snapshotData?.ticker?.lastTrade?.p
        || snapshotData?.ticker?.day?.c
        || snapshotData?.ticker?.prevDay?.c
        || 0;

      if (!spot) return res.status(200).json({ symbol: sym, error: 'No spot price' });

      const today = new Date().toISOString().split('T')[0];
      const optRes = await fetch(
        `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date.gte=${today}&limit=50&apiKey=${polygonKey}`,
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
        const type_ = r.details?.contract_type ?? '';
        const oi = r.open_interest ?? 0;
        const vol = r.day?.volume ?? 0;
        if (type_ === 'call') { totalCallOI += oi; totalCallVol += vol; }
        if (type_ === 'put')  { totalPutOI  += oi; totalPutVol  += vol; }
        const dist = Math.abs(strike - spot);
        if (type_ === 'call' && dist < minCallDist) { minCallDist = dist; atmCall = r; }
        if (type_ === 'put'  && dist < minPutDist)  { minPutDist = dist; atmPut  = r; }
      }

      const callIV    = atmCall?.greeks?.implied_volatility ? atmCall.greeks.implied_volatility * 100 : null;
      const callDelta = atmCall?.greeks?.delta ?? null;
      const callGamma = atmCall?.greeks?.gamma ?? null;
      const callTheta = atmCall?.greeks?.theta ?? null;
      const putIV     = atmPut?.greeks?.implied_volatility  ? atmPut.greeks.implied_volatility * 100  : null;
      const putDelta  = atmPut?.greeks?.delta  ?? null;
      const pcRatio   = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

      const callMid = atmCall ? ((atmCall.day?.ask ?? 0) + (atmCall.day?.bid ?? 0)) / 2 : 0;
      const putMid  = atmPut  ? ((atmPut.day?.ask  ?? 0) + (atmPut.day?.bid  ?? 0)) / 2  : 0;
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

  // ── Phase 3: Historical Volatility (5yr daily bars → HV computation) ─────────
  // Returns realized volatility at 10d, 20d, 60d, 252d windows
  // Also returns IV/HV ratio and whether options are cheap or expensive
  if (type === 'hv') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    try {
      // Fetch 5 years of daily bars (1260 trading days)
      const to   = new Date();
      const from = new Date(to.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
      const hvRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=1500&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );

      if (!hvRes.ok) {
        return res.status(200).json({ symbol: sym, error: `Polygon HV ${hvRes.status}` });
      }

      const hvData = await hvRes.json();
      const bars = hvData?.results ?? [];

      if (bars.length < 22) {
        return res.status(200).json({ symbol: sym, error: 'Insufficient history for HV', bars: bars.length });
      }

      // Compute log returns (daily)
      // HV formula: annualized std dev of log returns × √252
      const closes = bars.map(b => b.c);
      const logReturns = [];
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] > 0 && closes[i - 1] > 0) {
          logReturns.push(Math.log(closes[i] / closes[i - 1]));
        }
      }

      function computeHV(returns, window) {
        if (returns.length < window) return null;
        const slice = returns.slice(-window);
        const mean = slice.reduce((a, b) => a + b, 0) / window;
        const variance = slice.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (window - 1);
        return parseFloat((Math.sqrt(variance * 252) * 100).toFixed(2));
      }

      const hv10  = computeHV(logReturns, 10);
      const hv20  = computeHV(logReturns, 20);
      const hv60  = computeHV(logReturns, 60);
      const hv252 = computeHV(logReturns, 252);

      // 52-week high/low from recent closes
      const last252Closes = closes.slice(-252);
      const high52w = Math.max(...last252Closes);
      const low52w  = Math.min(...last252Closes);
      const currentClose = closes[closes.length - 1];

      // IV/HV ratio — caller passes iv as query param if available
      const ivParam = req.query.iv ? parseFloat(req.query.iv) : null;
      const ivHvRatio = ivParam && hv20 ? parseFloat((ivParam / hv20).toFixed(2)) : null;
      // Options are "expensive" when IV > 1.5x HV20
      const expensiveOptions = ivHvRatio != null ? ivHvRatio > 1.5 : null;
      // Options are "cheap" when IV < 0.8x HV20 (unusual)
      const cheapOptions = ivHvRatio != null ? ivHvRatio < 0.8 : null;

      // Price percentile (where today's price sits in 5yr range)
      const allCloses = closes;
      const below = allCloses.filter(c => c <= currentClose).length;
      const pricePercentile = Math.round((below / allCloses.length) * 100);

      // Last 252 trading days for sparkline / chart display
      const priceHistory = bars.slice(-252).map(b => ({
        date: new Date(b.t).toISOString().split('T')[0],
        close: b.c,
        volume: b.v,
      }));

      return res.status(200).json({
        symbol: sym,
        hv10,
        hv20,
        hv60,
        hv252,
        ivHvRatio,
        expensiveOptions,
        cheapOptions,
        high52w,
        low52w,
        currentClose,
        pricePercentile,
        totalBars: bars.length,
        priceHistory,
        source: 'polygon-5yr',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, error: e.message || 'HV computation failed' });
    }
  }

  // ── Main quote — REAL-TIME via Polygon snapshot (PRIMARY) ────────────────────
  if (!polygonKey) {
    return fetchYahooFallback(sym, res);
  }

  try {
    const isIndex = sym.startsWith('^') || sym === 'VIX' || sym === 'SPX';
    const polygonSym = isIndex
      ? sym.replace('^', 'I:').replace('VIX', 'I:VIX').replace('SPX', 'I:SPX')
      : sym;

    const snapshotUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(polygonSym)}?apiKey=${polygonKey}`;
    const snapshotRes = await fetch(snapshotUrl, {
      headers: { 'User-Agent': 'Helios/3.0' },
    });

    if (!snapshotRes.ok) {
      return fetchYahooFallback(sym, res);
    }

    const json = await snapshotRes.json();
    const ticker = json?.ticker;

    if (!ticker) {
      return fetchYahooFallback(sym, res);
    }

    const price = ticker.lastTrade?.p
      || ticker.lastQuote?.P
      || ticker.day?.c
      || ticker.prevDay?.c
      || 0;

    const prevClose = ticker.prevDay?.c || ticker.day?.o || price;
    const change = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    const dayData = ticker.day ?? {};
    const high = dayData.h || price;
    const low  = dayData.l || price;
    const open = dayData.o || prevClose;
    const volume = dayData.v || 0;

    const vwap = dayData.vw || null;
    const lastTradeSize = ticker.lastTrade?.s || null;
    const lastTradeTime = ticker.lastTrade?.t || null;

    const bid  = ticker.lastQuote?.p || null;
    const ask  = ticker.lastQuote?.P || null;
    const bidAskSpread = bid && ask ? ((ask - bid) / ask * 100).toFixed(3) : null;

    return res.status(200).json({
      symbol: sym,
      price,
      change,
      changePct,
      high,
      low,
      open,
      prevClose,
      volume,
      vwap,
      bid,
      ask,
      bidAskSpread,
      lastTradeSize,
      lastTradeTime,
      todayVolumeRatio: dayData.v && ticker.prevDay?.v
        ? parseFloat((dayData.v / ticker.prevDay.v).toFixed(2))
        : null,
      source: 'polygon-realtime',
      partialCandle: false,
    });
  } catch (err) {
    return fetchYahooFallback(sym, res);
  }
};

// ── Yahoo Finance fallback (15-min delayed — only used when Polygon fails) ─────
async function fetchYahooFallback(sym, res) {
  try {
    const yahooRes = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios/3.0)', Accept: 'application/json' } }
    );
    if (!yahooRes.ok) throw new Error(`Yahoo status ${yahooRes.status}`);
    const json = await yahooRes.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('No meta in Yahoo response');

    const price = meta.regularMarketPrice ?? meta.previousClose ?? 0;
    const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    const rawHigh = meta.regularMarketDayHigh ?? null;
    const rawLow  = meta.regularMarketDayLow  ?? null;
    const rawOpen = meta.regularMarketOpen    ?? null;
    const estOpen = rawOpen ?? prevClose;
    const estHigh = rawHigh != null ? Math.max(rawHigh, price, estOpen) : Math.max(price, estOpen);
    const estLow  = rawLow  != null ? Math.min(rawLow,  price, estOpen) : Math.min(price, estOpen);

    return res.status(200).json({
      symbol: sym,
      price,
      change,
      changePct,
      high: estHigh,
      low:  estLow,
      open: estOpen,
      prevClose,
      volume: meta.regularMarketVolume ?? 0,
      name: meta.shortName ?? meta.longName ?? sym,
      week52High: meta.fiftyTwoWeekHigh ?? null,
      week52Low:  meta.fiftyTwoWeekLow  ?? null,
      vwap: null,
      bid: null,
      ask: null,
      source: 'yahoo-delayed',
      partialCandle: !rawHigh || !rawLow || !rawOpen,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Quote fetch failed' });
  }
}
