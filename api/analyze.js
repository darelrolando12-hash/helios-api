
import Anthropic from "@anthropic-ai/sdk";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { image, mediaType } = req.body;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
      { type: "text", text: `Analyze this trading chart. Return ONLY a JSON object with exactly these keys: what_the_chart_shows, case_for_calls, case_for_puts, risks_and_blind_spots, balanced_summary` }
    ]}]
  });
  const json = JSON.parse(response.content[0].text);
  res.json(json);
}
