module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, type } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const sym = symbol.toUpperCase().trim();
  const polygonKey = process.env.POLYGON_API_KEY;

  // ── Shared spot price helper — same pattern as chain.js (proven to work) ──────
  async function fetchSpot(ticker) {
    try {
      const polygonTicker = ticker.startsWith('^')
        ? ticker.replace('^', 'I:')
        : ticker === 'SPX' ? 'I:SPX'
        : ticker === 'NDX' ? 'I:NDX'
        : ticker === 'RUT' ? 'I:RUT'
        : ticker === 'VIX' ? 'I:VIX'
        : ticker;

      let livePrice = null, liveSize = null, liveTime = null;
      try {
        const liveRes = await fetch(
          `https://api.polygon.io/v2/last/stocks/${encodeURIComponent(polygonTicker)}?apiKey=${polygonKey}`,
          { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Helios/3.0' } }
        );
        if (liveRes.ok) {
          const liveData = await liveRes.json();
          livePrice = liveData?.results?.p ?? null;
          liveSize  = liveData?.results?.s ?? null;
          liveTime  = liveData?.results?.t ?? null;
        }
      } catch { /* fallthrough to prev */ }

      const prevRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(polygonTicker)}/prev?adjusted=true&apiKey=${polygonKey}`,
        { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Helios/3.0' } }
      );
      let prevClose = null, high = null, low = null, open = null, volume = null, vwap = null;
      if (prevRes.ok) {
        const prevData = await prevRes.json();
        const r = prevData?.results?.[0];
        if (r) {
          prevClose = r.c;
          high      = r.h;
          low       = r.l;
          open      = r.o;
          volume    = r.v;
          vwap      = r.vw ?? null;
        }
      }

      return {
        price:     livePrice ?? prevClose,
        prevClose: prevClose ?? livePrice,
        high, low, open, volume, vwap,
        liveSize, liveTime,
      };
    } catch {
      return { price: null, prevClose: null, high: null, low: null, open: null, volume: null, vwap: null };
    }
  }

  // ── Yahoo Finance fallback ────────────────────────────────────────────────────
  async function fetchYahooFallback() {
    try {
      const yahooRes = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
        { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!yahooRes.ok) return res.status(200).json({ symbol: sym, price: null, error: 'Yahoo failed' });
      const yahooData = await yahooRes.json();
      const meta = yahooData?.chart?.result?.[0]?.meta;
      if (!meta) return res.status(200).json({ symbol: sym, price: null, error: 'Yahoo no meta' });
      const price     = meta.regularMarketPrice ?? meta.previousClose ?? null;
      const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
      const change    = price && prevClose ? price - prevClose : 0;
      const changePct = prevClose ? (change / prevClose) * 100 : 0;
      return res.status(200).json({
        symbol: sym, price, change, changePct,
        high:     meta.regularMarketDayHigh  ?? price,
        low:      meta.regularMarketDayLow   ?? price,
        open:     meta.regularMarketOpen     ?? prevClose,
        prevClose,
        volume:   meta.regularMarketVolume   ?? 0,
        vwap:     null,
        bid: null, ask: null,
        source: 'yahoo-fallback',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, price: null, error: e.message });
    }
  }

  // ── Historical Volatility ─────────────────────────────────────────────────────
  if (type === 'hv') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, hv10: null, hv20: null, hv60: null, hv252: null, error: 'No Polygon key' });
    try {
      const to   = new Date();
      const from = new Date(to.getTime() - 365 * 5 * 24 * 60 * 60 * 1000);
      const hvTicker = sym.startsWith('^') ? sym.replace('^', 'I:') : sym === 'SPX' ? 'I:SPX' : sym;
      const hvRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(hvTicker)}/range/1/day/${from.toISOString().slice(0,10)}/${to.toISOString().slice(0,10)}?adjusted=true&sort=asc&limit=1500&apiKey=${polygonKey}`,
        { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!hvRes.ok) return res.status(200).json({ symbol: sym, hv10: null, hv20: null, hv60: null, hv252: null, error: `Polygon ${hvRes.status}` });
      const hvData  = await hvRes.json();
      const closes  = (hvData?.results ?? []).map(b => b.c).filter(Boolean);
      if (closes.length < 20) return res.status(200).json({ symbol: sym, hv10: null, hv20: null, hv60: null, hv252: null, error: 'Not enough data' });
      const logReturns = [];
      for (let i = 1; i < closes.length; i++) logReturns.push(Math.log(closes[i] / closes[i - 1]));
      function calcHV(n) {
        if (logReturns.length < n) return null;
        const slice = logReturns.slice(-n);
        const mean  = slice.reduce((a, b) => a + b, 0) / n;
        const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
        return Math.sqrt(variance * 252) * 100;
      }
      return res.status(200).json({ symbol: sym, hv10: calcHV(10), hv20: calcHV(20), hv60: calcHV(60), hv252: calcHV(252), source: 'polygon-computed', bars: closes.length });
    } catch (e) {
      return res.status(200).json({ symbol: sym, hv10: null, hv20: null, hv60: null, hv252: null, error: e.message });
    }
  }

  // ── Validate contract existence (Yahoo Finance) ───────────────────────────────
  if (type === 'validate_contract') {
    const { expiry, strike, optionType } = req.query;
    if (!expiry || !strike || !optionType) {
      return res.status(200).json({ exists: false, error: 'Missing expiry/strike/optionType' });
    }
    try {
      const d = expiry.replace(/-/g, '').slice(2);
      const strikeFormatted = (parseFloat(strike) * 1000).toFixed(0).padStart(8, '0');
      const contractSym = `${sym}${d}${optionType[0].toUpperCase()}${strikeFormatted}`;
      const yahooSym    = encodeURIComponent(`${contractSym}`);
      const yahooUrl    = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=1d`;
      const yr = await fetch(yahooUrl, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!yr.ok) return res.status(200).json({ exists: false, contractSymbol: contractSym, source: 'yahoo' });
      const yd   = await yr.json();
      const meta = yd?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return res.status(200).json({ exists: false, contractSymbol: contractSym, source: 'yahoo' });
      const match = yd?.chart?.result?.[0];
      const targetStrike = parseFloat(strike);
      return res.status(200).json({
        exists: true,
        contractSymbol: contractSym,
        strike: match?.strike ?? targetStrike,
        expiry,
        optionType,
        bid:              match?.bid              ?? null,
        ask:              match?.ask              ?? null,
        lastPrice:        match?.lastPrice        ?? null,
        openInterest:     match?.openInterest     ?? null,
        impliedVolatility: match?.impliedVolatility ?? null,
        source: 'yahoo-delayed',
      });
    } catch (err) {
      return res.status(200).json({ exists: null, error: err.message, source: 'yahoo-delayed' });
    }
  }

  // ── Intraday candles (last 60 × 1-min bars) ───────────────────────────────────
  if (type === 'candles') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const now  = new Date();
      const from = new Date(now.getTime() - 60 * 60 * 1000);
      const candleTicker = sym.startsWith('^') ? sym.replace('^', 'I:')
        : sym === 'SPX' ? 'I:SPX'
        : sym === 'NDX' ? 'I:NDX'
        : sym === 'VIX' ? 'I:VIX'
        : sym;
      const candleRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(candleTicker)}/range/1/minute/${from.toISOString()}/${now.toISOString()}?adjusted=true&sort=asc&limit=60&apiKey=${polygonKey}`,
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

  // ── 5-minute candles (last 2 hours — for ATR, momentum, consolidation) ────────
  if (type === 'candles5m') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, bars: [], error: 'No Polygon key' });
    try {
      const now  = new Date();
      const from = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const polygonTicker = sym.startsWith('^') ? sym.replace('^', 'I:')
        : sym === 'SPX' ? 'I:SPX'
        : sym === 'NDX' ? 'I:NDX'
        : sym === 'VIX' ? 'I:VIX'
        : sym;
      const candleRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(polygonTicker)}/range/5/minute/${from.toISOString()}/${now.toISOString()}?adjusted=true&sort=asc&limit=24&apiKey=${polygonKey}`,
        { headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!candleRes.ok) return res.status(200).json({ symbol: sym, bars: [], error: `Polygon ${candleRes.status}` });
      const data = await candleRes.json();
      const bars = (data?.results ?? []).map(b => ({
        time: b.t,
        open: b.o, high: b.h, low: b.l, close: b.c,
        volume: b.v, vwap: b.vw ?? null,
      }));
      return res.status(200).json({ symbol: sym, bars, count: bars.length, source: 'polygon-realtime', resolution: '5min' });
    } catch (e) {
      return res.status(200).json({ symbol: sym, bars: [], error: e.message || 'Candles5m failed' });
    }
  }

  // ── 20-day ADV (average daily volume) OR historical OHLCV range ──────────────
  if (type === 'agg') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: 'No Polygon key' });
    try {
      const customFrom = req.query.from;
      const customTo   = req.query.to;
      const timespan   = req.query.timespan  || 'day';
      const multiplier = req.query.multiplier || '1';
      const to   = customTo   || new Date().toISOString().slice(0, 10);
      const from = customFrom || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const aggRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=30&apiKey=${polygonKey}`,
        { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!aggRes.ok) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: `Polygon ${aggRes.status}` });
      const aggData = await aggRes.json();
      const bars    = aggData?.results ?? [];
      if (!bars.length) return res.status(200).json({ symbol: sym, avgDailyVolume: 0, bars: [], error: 'No agg data' });
      const avgDailyVolume = Math.round(bars.reduce((s, b) => s + (b.v || 0), 0) / bars.length);
      return res.status(200).json({
        symbol: sym, avgDailyVolume,
        bars: bars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw ?? null })),
        source: 'polygon-agg',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, avgDailyVolume: 0, error: e.message });
    }
  }

  // ── ATM options snapshot (Greeks + IV + P/C ratio) ───────────────────────────
  if (type === 'options') {
    if (!polygonKey) return res.status(200).json({ symbol: sym, atmIV: null, error: 'No Polygon key' });
    try {
      const spot = await fetchSpot(sym);
      if (!spot.price) return res.status(200).json({ symbol: sym, atmIV: null, error: 'No spot price' });
      const price = spot.price;
      const today = new Date().toISOString().slice(0, 10);
      const expLimit = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const optRes = await fetch(
        `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?expiration_date.gte=${today}&expiration_date.lte=${expLimit}&limit=250&apiKey=${polygonKey}`,
        { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Helios/3.0' } }
      );
      if (!optRes.ok) return res.status(200).json({ symbol: sym, atmIV: null, error: `Polygon ${optRes.status}` });
      const optData   = await optRes.json();
      const contracts = optData?.results ?? [];
      if (!contracts.length) return res.status(200).json({ symbol: sym, atmIV: null, error: 'No contracts' });
      const atm = contracts
        .filter(c => c.details?.strike_price && c.greeks?.delta != null)
        .sort((a, b) => Math.abs(a.details.strike_price - price) - Math.abs(b.details.strike_price - price));
      const atmCall = atm.find(c => c.details?.contract_type === 'call');
      const atmPut  = atm.find(c => c.details?.contract_type === 'put');
      const atmIV   = atmCall?.implied_volatility ?? atmPut?.implied_volatility ?? null;
      let totalCallVol = 0, totalPutVol = 0;
      contracts.forEach(c => {
        const v = c.day?.volume ?? 0;
        if (c.details?.contract_type === 'call') totalCallVol += v;
        else totalPutVol += v;
      });
      const pcRatio = totalCallVol > 0 ? totalPutVol / totalCallVol : null;
      return res.status(200).json({
        symbol: sym, price,
        atmIV:    atmIV   ? Math.round(atmIV * 100 * 10) / 10 : null,
        atmDelta: atmCall?.greeks?.delta ?? null,
        atmGamma: atmCall?.greeks?.gamma ?? null,
        atmTheta: atmCall?.greeks?.theta ?? null,
        atmVega:  atmCall?.greeks?.vega  ?? null,
        pcRatio:  pcRatio ? Math.round(pcRatio * 100) / 100 : null,
        totalCallVolume: totalCallVol,
        totalPutVolume:  totalPutVol,
        contractCount: contracts.length,
        source: 'polygon-options-snapshot',
      });
    } catch (e) {
      return res.status(200).json({ symbol: sym, atmIV: null, error: e.message });
    }
  }

  // ── Main quote endpoint ───────────────────────────────────────────────────────
  if (!polygonKey) {
    return fetchYahooFallback();
  }

  try {
    const spot = await fetchSpot(sym);

    if (!spot.price) {
      return fetchYahooFallback();
    }

    const price     = spot.price;
    const prevClose = spot.prevClose || price;
    const change    = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return res.status(200).json({
      symbol:   sym,
      price,
      change,
      changePct,
      high:     spot.high  || price,
      low:      spot.low   || price,
      open:     spot.open  || prevClose,
      prevClose,
      volume:   spot.volume || 0,
      vwap:     spot.vwap  || null,
      bid:      null,
      ask:      null,
      lastTradeSize: spot.liveSize,
      lastTradeTime: spot.liveTime,
      source: spot.price === spot.prevClose ? 'polygon-prev-close' : 'polygon-realtime',
      partialCandle: false,
    });
  } catch (err) {
    return fetchYahooFallback();
  }
};
