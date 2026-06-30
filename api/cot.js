const CFTC_BASE = 'https://publicreporting.cftc.gov/api/odata/v1';

// Instrument map: name → CFTC market code used in the Socrata API
const INSTRUMENTS = [
  { symbol: 'ES', name: 'E-Mini S&P 500', marketCode: '13874+' },
  { symbol: 'NQ', name: 'E-Mini Nasdaq 100', marketCode: '20974+' },
  { symbol: 'RTY', name: 'E-Mini Russell 2000', marketCode: '239742' },
  { symbol: 'GC', name: 'Gold Futures', marketCode: '088691' },
];

// Fetch last N weeks of COT data for one instrument
async function fetchCOTRows(marketCode, weeks = 52) {
  // CFTC Socrata OData endpoint — FinancialByCrop report (legacy format, most reliable)
  const url =
    `${CFTC_BASE}/FinFutComb?$filter=cftc_market_code eq '${encodeURIComponent(marketCode)}'` +
    `&$orderby=report_date_as_yyyy_mm_dd desc&$top=${weeks}` +
    `&$select=report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,` +
    `comm_positions_long_all,comm_positions_short_all,` +
    `change_in_noncomm_long_all,change_in_noncomm_short_all,` +
    `change_in_comm_long_all,change_in_comm_short_all,` +
    `open_interest_all`;

  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) throw new Error(`CFTC status ${resp.status} for ${marketCode}`);
  const json = await resp.json();
  return json.value ?? [];
}

function parseRow(row) {
  const noncommLong  = parseInt(row.noncomm_positions_long_all  ?? '0', 10) || 0;
  const noncommShort = parseInt(row.noncomm_positions_short_all ?? '0', 10) || 0;
  const commLong     = parseInt(row.comm_positions_long_all     ?? '0', 10) || 0;
  const commShort    = parseInt(row.comm_positions_short_all    ?? '0', 10) || 0;
  const chgNoncommLong  = parseInt(row.change_in_noncomm_long_all  ?? '0', 10) || 0;
  const chgNoncommShort = parseInt(row.change_in_noncomm_short_all ?? '0', 10) || 0;
  const oi = parseInt(row.open_interest_all ?? '0', 10) || 0;

  return {
    date: row.report_date_as_yyyy_mm_dd ?? '',
    noncommNet: noncommLong - noncommShort,
    commNet: commLong - commShort,
    noncommNetChange: chgNoncommLong - chgNoncommShort,
    openInterest: oi,
  };
}

/**
 * Compute extremity score: where is current net vs 52-week range?
 * Returns -100 (max short) to +100 (max long). 0 = middle of range.
 */
function extremityScore(current, history) {
  if (history.length < 4) return 0;
  const nets = history.map(r => r.noncommNet);
  const max = Math.max(...nets);
  const min = Math.min(...nets);
  const range = max - min;
  if (range === 0) return 0;
  return Math.round(((current - min) / range) * 200 - 100);
}

function deriveBias(score, change) {
  // Extreme long + buying more = bearish contrarian (crowded long)
  if (score > 70 && change > 0) return 'bearish_contrarian';
  // Extreme long but reducing = early unwind warning
  if (score > 70 && change < -5000) return 'caution_long_unwind';
  // Extreme short + covering = bullish contrarian
  if (score < -70 && change < 0) return 'bullish_contrarian';
  // Extreme short but adding = caution
  if (score < -70 && change > 5000) return 'caution_short_adding';
  // Moderate long momentum
  if (score > 30 && change > 2000) return 'bullish';
  // Moderate short momentum
  if (score < -30 && change < -2000) return 'bearish';
  return 'neutral';
}

function biasToSignal(bias) {
  switch (bias) {
    case 'bullish_contrarian':
    case 'bullish': return 'bullish';
    case 'bearish_contrarian':
    case 'caution_long_unwind': return 'bearish';
    case 'caution_short_adding': return 'bullish';
    default: return 'neutral';
  }
}

function biasLabel(bias) {
  switch (bias) {
    case 'bullish_contrarian': return 'Extreme Short — Contrarian Bullish';
    case 'caution_long_unwind': return 'Long Unwind — Watch for Selling';
    case 'bearish_contrarian': return 'Extreme Long — Contrarian Bearish';
    case 'caution_short_adding': return 'Extreme Short Adding — High Risk';
    case 'bullish': return 'Spec Longs Building';
    case 'bearish': return 'Spec Shorts Building';
    default: return 'Neutral — No Extreme Positioning';
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Optional: filter to a single symbol
  const { symbol } = req.query;
  const targets = symbol
    ? INSTRUMENTS.filter(i => i.symbol === symbol.toUpperCase())
    : INSTRUMENTS;

  if (targets.length === 0) {
    return res.status(400).json({ error: `Unknown symbol. Valid: ${INSTRUMENTS.map(i => i.symbol).join(', ')}` });
  }

  try {
    const results = await Promise.all(
      targets.map(async (inst) => {
        const rows = await fetchCOTRows(inst.marketCode, 52);
        if (rows.length === 0) {
          return {
            symbol: inst.symbol,
            name: inst.name,
            error: 'No data returned from CFTC',
          };
        }

        const parsed = rows.map(parseRow).filter(r => r.date);
        const latest = parsed[0];
        const prior  = parsed[1] ?? latest;
        const score  = extremityScore(latest.noncommNet, parsed);
        const bias   = deriveBias(score, latest.noncommNet - prior.noncommNet);
        const signal = biasToSignal(bias);

        // 4-week net change for trend context
        const fourWeekAgo = parsed[3] ?? parsed[parsed.length - 1];
        const fourWeekNetChange = latest.noncommNet - fourWeekAgo.noncommNet;

        // Historical net array for sparkline (last 26 weeks, oldest→newest)
        const sparkline = parsed
          .slice(0, 26)
          .reverse()
          .map(r => r.noncommNet);

        return {
          symbol: inst.symbol,
          name: inst.name,
          reportDate: latest.date,
          // Positioning
          noncommNet: latest.noncommNet,         // Speculator net (longs - shorts)
          commNet: latest.commNet,               // Commercial/hedger net
          noncommNetChange: latest.noncommNet - prior.noncommNet,  // Week-over-week
          fourWeekNetChange,
          openInterest: latest.openInterest,
          // Intelligence
          extremityScore: score,                 // -100 to +100
          bias,                                  // full bias label key
          biasLabel: biasLabel(bias),
          signal,                                // simplified: 'bullish' | 'bearish' | 'neutral'
          // Sparkline data (26 weeks)
          sparkline,
          // Cache hint
          cachedAt: Date.now(),
        };
      })
    );

    // Cache 6 hours — COT only updates weekly
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    return res.status(200).json({ data: results, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[COT] Fetch error:', err.message);
    return res.status(500).json({ error: err.message ?? 'COT fetch failed' });
  }
};
