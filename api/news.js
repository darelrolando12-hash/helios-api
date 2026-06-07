module.exports = async function handler(req, res) {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  let sym = symbol.toUpperCase().trim();

  if (sym === 'VIX') sym = '^VIX';

  try {
    const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`;
    
    const response = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Helios/1.0)' },
    });

    if (!response.ok) throw new Error(`Yahoo RSS failed: ${response.status}`);

    const xml = await response.text();
    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

    const headlines = itemMatches.slice(0, 8).map((item) => {
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

      const title = titleMatch ? titleMatch[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"') : '';

      return {
        title,
        url: linkMatch ? linkMatch[1].trim() : '#',
        publishedAt: pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString(),
      };
    }).filter((h) => h.title.length > 5);

    return res.status(200).json({ headlines });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'News fetch failed' });
  }
};
