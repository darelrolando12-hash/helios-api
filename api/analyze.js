export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, timeframe, bias, context } = req.body;
  if (!image) return res.status(400).json({ error: 'image required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // Strip data URL prefix if present
  const base64 = image.replace(/^data:image\/\w+;base64,/, '');

  const contextText = [
    timeframe ? `Timeframe: ${timeframe}` : null,
    bias ? `Trader bias: ${bias}` : null,
    context ? `Additional context: ${context}` : null,
  ].filter(Boolean).join('. ') || 'General chart analysis requested.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
              },
              {
                type: 'text',
                text: `You are an elite options and futures chart analyst. Analyze this chart with precision and provide actionable insights.

${contextText}

Provide your analysis in this exact JSON format:
{
  "bias": "bullish" | "bearish" | "neutral",
  "conviction": 1-10,
  "summary": "2-3 sentence overview of what you see",
  "pattern": "pattern name if any",
  "keyLevels": ["support/resistance levels as strings"],
  "risks": ["key risk factors"],
  "plays": [
    {
      "type": "calls" | "puts",
      "strike": "suggested strike",
      "expiry": "suggested expiry",
      "rationale": "why this play",
      "confidence": 1-100
    }
  ],
  "timeframeOutlook": "short-term price outlook",
  "volumeAnalysis": "volume interpretation",
  "recommendation": "ENTER NOW" | "WAIT" | "AVOID"
}

Return ONLY the JSON object, no markdown.`,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
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
