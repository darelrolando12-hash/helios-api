const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { symbol, expiry } = req.query;

  if (!symbol || !expiry) {
    return res.status(400).json({ error: 'symbol and expiry required' });
  }

  try {
    // Get the most recent snapshot for this symbol+expiry
    const { data, error } = await supabase
      .from('greeks_snapshots')
      .select('*')
      .eq('symbol', symbol.toUpperCase())
      .eq('expiry', expiry)
      .order('snapshot_time', { ascending: false })
      .limit(200); // Get up to 200 strikes

    if (error) {
      console.error('[greeks-snapshot] Supabase error:', error);
      return res.status(200).json({ snapshots: [] });
    }

    return res.status(200).json({ 
      snapshots: data || [],
      source: 'database',
      snapshotTime: data?.[0]?.snapshot_time || null
    });

  } catch (err) {
    console.error('[greeks-snapshot] Error:', err);
    return res.status(200).json({ snapshots: [] });
  }
};
