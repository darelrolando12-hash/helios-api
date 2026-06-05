module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, datesOnly, expiration } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const sym = symbol.toUpperCase().trim();
  const polygonKey = process.env.POLYGON_API_KEY;
  if (!polygonKey) return res.status(200).json({ expiryDates: [], contracts: [] });

  if (datesOnly === 'true') {
    try {
      const url = 'https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=' + sym + '&limit=1000&apiKey=' + polygonKey;
      const response = await fetch(url);
      if (!response.ok) return res.status(200).json({ expiryDates: [] });
      const data = await response.json();
      if (!data.results || !Array.isArray(data.results)) return res.status(200).json({ expiryDates: [] });
      const dates = new Set();
      data.results.forEach(function(c) { if (c.expiration_date) dates.add(c.expiration_date); });
      const sortedDates = Array.from(dates).sort();
      return res.status(200).json({ expiryDates: sortedDates, count: sortedDates.length });
    } catch (e) {
      return res.status(200).json({ expiryDates: [] });
    }
  }

  if (expiration) {
    try {
      const callsUrl = 'https://api.polygon.io/v3/snapshot/options/' + sym + '?contract_type=call&expiration_date=' + expiration + '&limit=250&apiKey=' + polygonKey;
      const putsUrl = 'https://api.polygon.io/v3/snapshot/options/' + sym + '?contract_type=put&expiration_date=' + expiration + '&limit=250&apiKey=' + polygonKey;
      const results = await Promise.all([fetch(callsUrl), fetch(putsUrl)]);
      const callsData = await results[0].json();
      const putsData = await results[1].json();
      let spot = 0;
      if (callsData.results && callsData.results[0] && callsData.results[0].underlying_asset) spot = callsData.results[0].underlying_asset.price || 0;
      const contractMap = new Map();
      (callsData.results || []).forEach(function(c) {
        const strike = c.details && c.details.strike_price;
        if (!strike) return;
        if (!contractMap.has(strike)) contractMap.set(strike, { strike, callBid:0,callAsk:0,callIV:0,callOI:0,callVolume:0,putBid:0,putAsk:0,putIV:0,putOI:0,putVolume:0 });
        const ct = contractMap.get(strike);
        ct.callBid = (c.market_data && c.market_data.bid) || 0;
        ct.callAsk = (c.market_data && c.market_data.ask) || 0;
        ct.callIV = (c.greeks && c.greeks.implied_volatility) || 0;
        ct.callOI = c.open_interest || 0;
        ct.callVolume = c.volume || 0;
      });
      (putsData.results || []).forEach(function(p) {
        const strike = p.details && p.details.strike_price;
        if (!strike) return;
        if (!contractMap.has(strike)) contractMap.set(strike, { strike, callBid:0,callAsk:0,callIV:0,callOI:0,callVolume:0,putBid:0,putAsk:0,putIV:0,putOI:0,putVolume:0 });
        const ct = contractMap.get(strike);
        ct.putBid = (p.market_data && p.market_data.bid) || 0;
        ct.putAsk = (p.market_data && p.market_data.ask) || 0;
        ct.putIV = (p.greeks && p.greeks.implied_volatility) || 0;
        ct.putOI = p.open_interest || 0;
        ct.putVolume = p.volume || 0;
      });
      const contracts = Array.from(contractMap.values()).sort(function(a,b){ return a.strike - b.strike; }).map(function(c) {
        const step = spot < 10 ? 0.5 : spot < 50 ? 1 : spot < 200 ? 5 : 10;
        return Object.assign({}, c, { atm: Math.abs(c.strike-spot) < step*0.6, itmCall: c.strike<spot, itmPut: c.strike>spot });
      });
      return res.status(200).json({ symbol: sym, spot, expiration, contracts });
    } catch (e) {
      return res.status(200).json({ contracts: [], symbol: sym, spot: 0, expiration });
    }
  }

  return res.status(400).json({ error: 'Either datesOnly=true or expiration required' });
};
