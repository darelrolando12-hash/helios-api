import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, mediaType, context } = req.body;

  if (!image || !mediaType) {
    return res.status(400).json({ error: 'Missing image or mediaType' });
  }

  const contextLine = context
    ? `\n\nAdditional context from the trader: ${context}`
    : '';

  const prompt = `You are a professional technical analyst. Analyze this chart image objectively and return ONLY valid JSON.${contextLine}

Return exactly this structure:
{
  "bullCase": "2-3 sentences on bullish scenario",
  "bearCase": "2-3 sentences on bearish scenario",
  "keyLevels": ["level 1", "level 2", "level 3"],
  "risks": ["risk 1", "risk 2"],
  "summary": "1 balanced sentence"
}

Rules:
- No buy/sell recommendations
- No price targets
- Challenge any bias mentioned in the context critically
- Base analysis purely on visible chart patterns, structure, and indicators
- Return ONLY the JSON object, no extra text`;

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: image,
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    });

    const text = response.content[0].text.trim();
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'Claude returned invalid JSON', raw: text });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: err.message || 'Analysis failed' });
  }
}
