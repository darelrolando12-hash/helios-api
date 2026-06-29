module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, type } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const sym = symbol.toUpperCase().trim();
  const polygonKey = process.env.POLYGON_API_KEY;

  // ── Yahoo Finance contract existence validator ────────────────────────────
  if (type === 'validate_contract') {
    const { expiry, strike, optionType } = req.query;
    if (!expiry || !strike || !optionType) {
      return res.status(400).json({ error: 'expiry, strike, optionType required' });
    }
    try {
      const expiryDate = new Date(expiry + 'T21:00:00Z');
      const expiryTs = Math.floor(expiryDate.getTime() / 1000);
      const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}?date=${expiryTs}`;
      const yahooRes = await fetch(yahooUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Helios/4.0)',
          'Accept': 'application/json',
        },
      });
      if (!yahooRes.ok) {
        return res.status(200).json({ exists: null, error: `Yahoo ${yahooRes.status}`, source: 'yahoo-delayed' });
      }
      const data = await yahooRes.json();
      const chain = data?.optionChain?.result?.[0];
      if (!chain) {
        return res.status(200).json({ exists: false, source: 'yahoo-delayed' });
      }
      const targetStrike = parseFloat(strike);
      const contracts = optionType === 'call'
        ? (chain.options?.[0]?.calls ?? [])
        : (chain.options?.[0]?.puts ?? []);
      const match = contracts.find(c => Math.abs(c.strike - targetStrike) < 0.01);
      return res.status(200).json({
        exists: !!match,
        strike: match?.strike ?? targetStrike,
        expiry,
        optionType,
        bid: match?.bid ?? null,
        ask: match?.ask ?? null,
        lastPrice: match?.lastPrice ?? null,
        openInterest: match?.openInterest ?? null,
        impliedVolatility: match?.impliedVolatility ?? null,
        source: 'yahoo-delayed',
      });
    } catch (e) {
      return res.status(200).json({ exists: null, error: e.message, source: 'yahoo-delayed' });
    }
  }

  // ── Intraday candles (last 60 × 1-min bars) ──────────────────────────────
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
      return res.status(200).json({ symbol: sym, bars, source: 'polygon-realtime' });
    } catch (err) {
      return res.status(200).json({ symbol: sym, bars: [], error: err.message });
    }
  }

  // ── 20-day ADV ───────────────────────────────────────────────────────────
  if (type === 'agg') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, adv20: null, error: 'No Polygon key' });
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const aggRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from.toISOString().slice(0,10)}/${to.toISOString().slice(0,10)}?adjusted=true&sort=asc&limit=30&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!aggRes.ok) return res.status(200).json({ symbol: sym, adv20: null, error: `Polygon ${aggRes.status}` });
      const data = await aggRes.json();
      const bars = data?.results ?? [];
      const last20 = bars.slice(-20);
      const adv20 = last20.length > 0
        ? Math.round(last20.reduce((s, b) => s + (b.v ?? 0), 0) / last20.length)
        : null;
      return res.status(200).json({ symbol: sym, adv20, barCount: last20.length, source: 'polygon-realtime' });
    } catch (err) {
      return res.status(200).json({ symbol: sym, adv20: null, error: err.message });
    }
  }

  // ── ATM Options Greeks + IV + P/C ratio ──────────────────────────────────
  if (type === 'options') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    try {
      const spotRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/prev?adjusted=true&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      const spotData = await spotRes.json();
      const spot = spotData?.results?.[0]?.c ?? 0;

      const today = new Date().toISOString().slice(0, 10);
      const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const snapRes = await fetch(
        `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date.gte=${today}&expiration_date.lte=${expiry}&limit=250&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!snapRes.ok) throw new Error(`Polygon snapshot ${snapRes.status}`);
      const snapData = await snapRes.json();
      const results = snapData?.results ?? [];

      let atmCall = null, atmPut = null;
      let minCallDist = Infinity, minPutDist = Infinity;
      let totalCallOI = 0, totalPutOI = 0;
      let totalCallVol = 0, totalPutVol = 0;

      results.forEach(r => {
        const strike = r.details?.strike_price ?? 0;
        const type_  = r.details?.contract_type ?? '';
        const dist   = Math.abs(strike - spot);
        totalCallOI  += type_ === 'call' ? (r.open_interest ?? 0) : 0;
        totalPutOI   += type_ === 'put'  ? (r.open_interest ?? 0) : 0;
        totalCallVol += type_ === 'call' ? (r.day?.volume ?? 0) : 0;
        totalPutVol  += type_ === 'put'  ? (r.day?.volume ?? 0) : 0;
        if (type_ === 'call' && dist < minCallDist) { minCallDist = dist; atmCall = r; }
        if (type_ === 'put'  && dist < minPutDist)  { minPutDist  = dist; atmPut  = r; }
      });

      const callIV    = atmCall?.greeks?.implied_volatility ? atmCall.greeks.implied_volatility * 100 : null;
      const callDelta = atmCall?.greeks?.delta ?? null;
      const callGamma = atmCall?.greeks?.gamma ?? null;
      const callTheta = atmCall?.greeks?.theta ?? null;
      const putIV     = atmPut?.greeks?.implied_volatility  ? atmPut.greeks.implied_volatility  * 100 : null;
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

  // ── Historical Volatility (5yr daily bars) ───────────────────────────────
  if (type === 'hv') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    try {
      const to   = new Date();
      const from = new Date(to.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
      const hvRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=1500&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!hvRes.ok) throw new Error(`Polygon HV ${hvRes.status}`);
      const hvData = await hvRes.json();
      const bars = hvData?.results ?? [];
      if (bars.length < 22) {
        return res.status(200).json({ symbol: sym, error: 'Insufficient history for HV', bars: bars.length });
      }

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

      const last252Closes = closes.slice(-252);
      const high52w = Math.max(...last252Closes);
      const low52w  = Math.min(...last252Closes);
      const currentClose = closes[closes.length - 1];

      const ivParam = req.query.iv ? parseFloat(req.query.iv) : null;
      const ivHvRatio = ivParam && hv20 ? parseFloat((ivParam / hv20).toFixed(2)) : null;
      const expensiveOptions = ivHvRatio != null ? ivHvRatio > 1.5 : null;
      const cheapOptions     = ivHvRatio != null ? ivHvRatio < 0.8 : null;

      const allCloses = closes;
      const below = allCloses.filter(c => c <= currentClose).length;
      const pricePercentile = Math.round((below / allCloses.length) * 100);

      const priceHistory = bars.slice(-252).map(b => ({
        date: new Date(b.t).toISOString().split('T')[0],
        close: b.c,
        volume: b.v,
      }));

      return res.status(200).json({
        symbol: sym,
        hv10, hv20, hv60, hv252,
        ivHvRatio, expensiveOptions, cheapOptions,
        high52w, low52w, currentClose, pricePercentile,
        totalBars: bars.length,
        priceHistory,
        source: 'polygon-5yr',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, error: e.message || 'HV computation failed' });
    }
  }

  // ── Main quote — real-time via Polygon snapshot ──────────────────────────
  if (!polygonKey) {
    return fetchYahooFallback(sym, res);
  }

  try {
    const isIndex = sym.startsWith('^') || sym === 'VIX' || sym === 'SPX';
    const polygonSym = isIndex
      ? sym.replace('^', 'I:').replace('VIX', 'I:VIX').replace('SPX', 'I:SPX')
      : sym;

    const snapshotUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(polygonSym)}?apiKey=${polygonKey}`;
    const snapshotRes = await fetch(snapshotUrl, { headers: { 'User-Agent': 'Helios/3.0' } });

    if (!snapshotRes.ok) return fetchYahooFallback(sym, res);

    const json = await snapshotRes.json();
    const ticker = json?.ticker;
    if (!ticker) return fetchYahooFallback(sym, res);

    const price     = ticker.lastTrade?.p || ticker.lastQuote?.P || ticker.day?.c || ticker.prevDay?.c || 0;
    const prevClose = ticker.prevDay?.c || ticker.day?.o || price;
    const change    = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
    const dayData   = ticker.day ?? {};

    return res.status(200).json({
      symbol: sym,
      price,
      change,
      changePct,
      high:   dayData.h || price,
      low:    dayData.l || price,
      open:   dayData.o || prevClose,
      prevClose,
      volume: dayData.v || 0,
      vwap:   dayData.vw || null,
      bid:    ticker.lastQuote?.p || null,
      ask:    ticker.lastQuote?.P || null,
      bidAskSpread: ticker.lastQuote?.p && ticker.lastQuote?.P
        ? ((ticker.lastQuote.P - ticker.lastQuote.p) / ticker.lastQuote.P * 100).toFixed(3)
        : null,
      lastTradeSize: ticker.lastTrade?.s || null,
      lastTradeTime: ticker.lastTrade?.t || null,
      todayVolumeRatio: dayData.v && ticker.prevDay?.v
        ? parseFloat((dayData.v / ticker.prevDay.v).toFixed(2))
        : null,
      source: 'polygon-realtime',
      partialCandle: false,
    });
  } catch {
    return fetchYahooFallback(sym, res);
  }
};

// ── Yahoo Finance fallback (15-min delayed) ──────────────────────────────────
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

    const price     = meta.regularMarketPrice ?? meta.previousClose ?? 0;
    const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change    = price - prevClose;
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
      bid:  null,
      ask:  null,
      source: 'yahoo-delayed',
      partialCandle: !rawHigh || !rawLow || !rawOpen,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Quote fetch failed' });
  }
}
