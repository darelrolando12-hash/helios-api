module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, type } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const sym = symbol.toUpperCase().trim();
  const polygonKey = process.env.POLYGON_API_KEY;

  // ── Intraday candles (last 30 × 1-min bars — real-time, was 5-min delayed) ──
  if (type === 'candles') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 60 * 60 * 1000); // last 60 min
      const candleRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/minute/${from.toISOString()}/${now.toISOString()}?adjusted=true&sort=asc&limit=60&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      if (!candleRes.ok) return res.status(200).json({ symbol: sym, bars: [], error: `Polygon ${candleRes.status}` });
      const data = await candleRes.json();
      const bars = (data?.results ?? []).slice(-30);
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
        { headers: { 'User-Agent': 'Helios/1.0' } }
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
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      const snapshotData = snapshotRes.ok ? await snapshotRes.json() : null;
      const spot = snapshotData?.ticker?.lastTrade?.p
        || snapshotData?.ticker?.day?.c
        || snapshotData?.ticker?.prevDay?.c
        || 0;

      if (!spot) return res.status(200).json({ symbol: sym, error: 'No spot price' });

      // Get nearest expiry
      const expiryRes = await fetch(
        `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${sym}&limit=50&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      if (!expiryRes.ok) return res.status(200).json({ symbol: sym, error: `Polygon expiry ${expiryRes.status}` });
      const expiryData = await expiryRes.json();
      const dates = [...new Set((expiryData.results || []).map(c => c.expiration_date))].sort();
      const today = new Date().toISOString().split('T')[0];
      const nearestExpiry = dates.find(d => d >= today) || dates[0];
      if (!nearestExpiry) return res.status(200).json({ symbol: sym, error: 'No expiry found' });

      // Fetch ATM contracts for that expiry
      const chainRes = await fetch(
        `https://api.polygon.io/v3/snapshot/options/${sym}?expiration_date=${nearestExpiry}&limit=250&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/1.0' } }
      );
      if (!chainRes.ok) return res.status(200).json({ symbol: sym, error: `Chain fetch ${chainRes.status}` });
      const chainData = await chainRes.json();
      const allContracts = chainData?.results ?? [];

      // Find ATM contracts (closest strike to spot)
      const strikes = [...new Set(allContracts.map(c => c.details?.strike_price).filter(Boolean))].sort((a, b) => a - b);
      const atmStrike = strikes.reduce((prev, curr) => Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev, strikes[0]);

      const atmCall = allContracts.find(c => c.details?.strike_price === atmStrike && c.details?.contract_type === 'call');
      const atmPut  = allContracts.find(c => c.details?.strike_price === atmStrike && c.details?.contract_type === 'put');

      const callIV    = atmCall?.greeks?.implied_volatility != null ? parseFloat((atmCall.greeks.implied_volatility * 100).toFixed(1)) : null;
      const putIV     = atmPut?.greeks?.implied_volatility  != null ? parseFloat((atmPut.greeks.implied_volatility  * 100).toFixed(1)) : null;
      const callDelta = atmCall?.greeks?.delta ?? null;
      const putDelta  = atmPut?.greeks?.delta  ?? null;
      const callGamma = atmCall?.greeks?.gamma ?? null;
      const callTheta = atmCall?.greeks?.theta ?? null;
      const callVega  = atmCall?.greeks?.vega  ?? null;
      const putGamma  = atmPut?.greeks?.gamma  ?? null;
      const putTheta  = atmPut?.greeks?.theta  ?? null;
      const putVega   = atmPut?.greeks?.vega   ?? null;

      // P/C ratio from full chain
      const totalCallVol = allContracts.filter(c => c.details?.contract_type === 'call').reduce((s, c) => s + (c.volume || 0), 0);
      const totalPutVol  = allContracts.filter(c => c.details?.contract_type === 'put').reduce((s, c) => s + (c.volume || 0), 0);
      const putCallRatio = totalCallVol > 0 ? parseFloat((totalPutVol / totalCallVol).toFixed(2)) : null;

      // Straddle implied move
      const callMid = atmCall ? ((atmCall.market_data?.bid || 0) + (atmCall.market_data?.ask || 0)) / 2 : 0;
      const putMid  = atmPut  ? ((atmPut.market_data?.bid  || 0) + (atmPut.market_data?.ask  || 0)) / 2 : 0;
      const impliedMove = callMid > 0 && putMid > 0 && spot > 0
        ? parseFloat(((callMid + putMid) / spot * 100).toFixed(2))
        : null;

      return res.status(200).json({
        symbol: sym,
        spot,
        expiry: nearestExpiry,
        atmStrike,
        callIV, putIV,
        callDelta, putDelta,
        callGamma, putGamma,
        callTheta, putTheta,
        callVega, putVega,
        putCallRatio,
        impliedMove,
        source: 'polygon-realtime',
      });
    } catch (err) {
      return res.status(200).json({ symbol: sym, error: err.message || 'Options fetch failed' });
    }
  }

  // ── Real-time quote (Polygon primary) ────────────────────────────────────────
  if (!polygonKey) return fetchYahooFallback(sym, res);

  try {
    const polygonRes = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${polygonKey}`,
      { headers: { 'User-Agent': 'Helios/1.0' } }
    );
    if (!polygonRes.ok) throw new Error(`Polygon ${polygonRes.status}`);
    const data = await polygonRes.json();
    const ticker = data?.ticker;
    if (!ticker) throw new Error('No ticker in Polygon response');

    const dayData    = ticker.day       ?? {};
    const prevData   = ticker.prevDay   ?? {};
    const lastTrade  = ticker.lastTrade ?? {};
    const lastQuote  = ticker.lastQuote ?? {};

    const price      = lastTrade.p || dayData.c || prevData.c || 0;
    const prevClose  = prevData.c  || 0;
    const change     = price - prevClose;
    const changePct  = prevClose !== 0 ? (change / prevClose) * 100 : 0;
    const high       = dayData.h  || price;
    const low        = dayData.l  || price;
    const open       = dayData.o  || prevClose;
    const volume     = dayData.v  || 0;
    const vwap       = dayData.vw || null;

    const lastTradeSize  = lastTrade.s ?? null;
    const lastTradeTime  = lastTrade.t ?? null;

    // Bid/ask spread — for real-time liquidity check
    const bid  = lastQuote.p || null;
    const ask  = lastQuote.P || null;
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
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios/1.0)', Accept: 'application/json' } }
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
