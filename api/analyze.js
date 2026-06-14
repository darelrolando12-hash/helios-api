module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY to Vercel environment variables.' });
  }

  const { image, ticker, timeframe, bias, context } = req.body ?? {};
  if (!image) return res.status(400).json({ error: 'image (base64) required' });

  let mediaType = 'image/jpeg';
  if (image.startsWith('data:image/png')) mediaType = 'image/png';
  else if (image.startsWith('data:image/webp')) mediaType = 'image/webp';

  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');

  const tickerLine    = ticker    ? `Ticker: ${ticker.toUpperCase()}` : '';
  const timeframeLine = timeframe ? `Timeframe: ${timeframe}` : '';
  const biasLine      = bias      ? `Trader bias going in: ${bias}` : '';
  const contextLine   = context   ? `Additional context: ${context}` : '';
  const contextBlock  = [tickerLine, timeframeLine, biasLine, contextLine].filter(Boolean).join('\n');

  const userPrompt = `You are an elite technical analysis AI inside a professional trading terminal called Helios.

${contextBlock ? `TRADE CONTEXT:\n${contextBlock}\n\n` : ''}Analyze this chart and return a structured JSON response with the following fields:
- signal: "calls" | "puts" | "neutral"
- conviction: number 0-100
- bias: string (1-sentence directional summary)
- summary: string (2-3 sentence overall read)
- keyLevels: array of { price: number, label: string, type: "support"|"resistance"|"target"|"stop" }
- patterns: array of strings (e.g. ["Bull Flag", "VWAP Reclaim"])
- risks: array of strings
- entryTip: string
- exitPlan: string
- playType: string (e.g. "Momentum Breakout")
- dte: string (e.g. "1-3 DTE", "7-14 DTE")
- confidence: "high" | "medium" | "low"

${timeframe ? `This is a ${timeframe} chart — calibrate DTE and hold time accordingly.` : ''}
${bias ? `Trader has a ${bias} bias — note whether the chart confirms or conflicts.` : ''}

Respond ONLY with valid JSON. No markdown fences.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            { type: 'text', text: userPrompt },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `AI error: ${response.status} — ${errText.slice(0, 100)}` });
    }

    const data = await response.json();
    const rawText = data?.content?.[0]?.text ?? '';
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = {
        signal: 'neutral', conviction: 50,
        bias: 'Could not parse structured response',
        summary: cleaned, keyLevels: [], patterns: [],
        risks: ['Parse error'], entryTip: 'Review manually',
        exitPlan: 'Use standard risk management',
        playType: 'Manual Review', dte: '7-14 DTE', confidence: 'low',
      };
    }

    return res.status(200).json({ analysis: parsed, raw: rawText });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Analysis failed' });
  }
};    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Claude API error: ${err}` });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text ?? '';

    // Parse JSON from response
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      parsed = { raw: text, bias: 'neutral', conviction: 5, summary: text };
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message ?? 'Unknown error' });
  }
}
