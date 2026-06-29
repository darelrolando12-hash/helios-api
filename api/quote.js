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
      return res.status(200).json({ symbol: sym, bars, source: 'polygon-realtime' });
    } catch (err) {
      return res.status(200).json({ symbol: sym, bars: [], error: err.message });
    }
  }

  // ── 20-day ADV (average daily volume) ────────────────────────────────────────
  if (type === 'agg') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, adv20: null, error: 'No Polygon key' });
    try {
      const to   = new Date();
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

  // ── ATM Options Greeks + IV + P/C ratio ──────────────────────────────────────
  if (type === 'options') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    try {
      // Get spot price first
      const spotRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/prev?adjusted=true&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      const spotData = await spotRes.json();
      const spot = spotData?.results?.[0]?.c ?? 0;

      // Nearest expiry options snapshot
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
        if (type_ === 'put'  && dist < minPutDist)  { minPutDist = dist; atmPut  = r; }
      });

      const callIV    = atmCall?.greeks?.implied_volatility ? atmCall.greeks.implied_volatility * 100 : null;
      const callDelta = atmCall?.greeks?.delta ?? null;
      const callGamma = atmCall?.greeks?.gamma ?? null;
      const callTheta = atmCall?.greeks?.theta ?? null;
      const putIV     = atmPut?.greeks?.implied_volatility  ? atmPut.greeks.implied_volatility * 100  : null;
      const putDelta  = atmPut?.greeks?.delta  ?? null;
      const pcRatio   = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

      // FIX: bid/ask lives at last_quote, NOT day.bid/day.ask
      const callMid = atmCall ? ((atmCall.last_quote?.ask ?? 0) + (atmCall.last_quote?.bid ?? 0)) / 2 : 0;
      const putMid  = atmPut  ? ((atmPut.last_quote?.ask  ?? 0) + (atmPut.last_quote?.bid  ?? 0)) / 2  : 0;
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

  // ── Historical Volatility (5yr daily bars → HV computation) ──────────────────
  if (type === 'hv') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, error: 'No Polygon key' });
    try {
      const toDate   = new Date().toISOString().slice(0, 10);
      const fromDate = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const hvRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=1500&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!hvRes.ok) throw new Error(`Polygon HV ${hvRes.status}`);
      const hvData = await hvRes.json();
      const bars = hvData?.results ?? [];
      if (bars.length < 20) throw new Error('Insufficient bar data for HV');

      // Log returns
      const logReturns = [];
      for (let i = 1; i < bars.length; i++) {
        if (bars[i].c > 0 && bars[i-1].c > 0) {
          logReturns.push(Math.log(bars[i].c / bars[i-1].c));
        }
      }

      function hv(window) {
        if (logReturns.length < window) return null;
        const slice = logReturns.slice(-window);
        const mean  = slice.reduce((s, v) => s + v, 0) / window;
        const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (window - 1);
        return parseFloat((Math.sqrt(variance * 252) * 100).toFixed(1));
      }

      const hv10  = hv(10);
      const hv20  = hv(20);
      const hv60  = hv(60);
      const hv252 = hv(252);

      // IV/HV ratio using most recent IV from options snapshot
      let currentIV = null;
      try {
        const ivRes = await fetch(
          `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?limit=10&apiKey=${polygonKey}`,
          { headers: { 'User-Agent': 'Helios/3.0' } }
        );
        if (ivRes.ok) {
          const ivData = await ivRes.json();
          const first = ivData?.results?.[0];
          if (first?.greeks?.implied_volatility) {
            currentIV = first.greeks.implied_volatility * 100;
          }
        }
      } catch { /* IV fetch optional */ }

      const ivHvRatio = currentIV && hv20 ? parseFloat((currentIV / hv20).toFixed(2)) : null;
      const expensiveOptions = ivHvRatio ? ivHvRatio > 1.2 : null;

      // Return last 252 bars for frontend charting
      const priceHistory = bars.slice(-252).map(b => ({
        date:   new Date(b.t).toISOString().slice(0, 10),
        close:  b.c,
        volume: b.v,
      }));

      return res.status(200).json({
        symbol: sym,
        hv10, hv20, hv60, hv252,
        currentIV,
        ivHvRatio,
        expensiveOptions,
        priceHistory,
        barCount: logReturns.length,
        source: 'polygon-realtime',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, error: e.message || 'HV fetch failed' });
    }
  }

  // ── Default: real-time quote ──────────────────────────────────────────────────
  if (!polygonKey) {
    return fetchYahoo(sym, res);
  }

  try {
    const polygonRes = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/prev?adjusted=true&apiKey=${polygonKey}`,
      { headers: { 'User-Agent': 'Helios/3.0' } }
    );
    if (!polygonRes.ok) throw new Error(`Polygon status ${polygonRes.status}`);
    const data = await polygonRes.json();
    const bar  = data?.results?.[0];
    if (!bar) throw new Error('No bar data');

    // Try live last-trade price
    let livePrice = 0;
    try {
      const liveRes = await fetch(
        `https://api.polygon.io/v2/last/stocks/${encodeURIComponent(sym)}?apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (liveRes.ok) {
        const liveData = await liveRes.json();
        livePrice = liveData?.results?.p ?? liveData?.last?.price ?? 0;
      }
    } catch { /* live price optional */ }

    const price     = livePrice > 0 ? livePrice : (bar.c ?? 0);
    const prevClose = bar.c ?? 0;
    const change    = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return res.status(200).json({
      symbol:    sym,
      price,
      change,
      changePct,
      high:      bar.h ?? price,
      low:       bar.l ?? price,
      open:      bar.o ?? price,
      prevClose,
      volume:    bar.v ?? 0,
      vwap:      bar.vw ?? null,
      bid:       null,
      ask:       null,
      name:      sym,
      week52High: null,
      week52Low:  null,
      source:    livePrice > 0 ? 'polygon-realtime' : 'polygon-prev-close',
    });
  } catch {
    return fetchYahoo(sym, res);
  }

  async function fetchYahoo(ticker, response) {
    try {
      const yahooRes = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`,
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

      return response.status(200).json({
        symbol: ticker,
        price,
        change,
        changePct,
        high: estHigh,
        low:  estLow,
        open: estOpen,
        prevClose,
        volume: meta.regularMarketVolume ?? 0,
        name: meta.shortName ?? meta.longName ?? ticker,
        week52High: meta.fiftyTwoWeekHigh ?? null,
        week52Low:  meta.fiftyTwoWeekLow  ?? null,
        vwap: null,
        bid: null,
        ask: null,
        source: 'yahoo-delayed',
        partialCandle: !rawHigh || !rawLow || !rawOpen,
      });
    } catch (err) {
      return response.status(500).json({ error: err.message || 'Quote fetch failed' });
    }
  }
};
