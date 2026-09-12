const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));

function requireKey(res) {
  if (!OPENAI_API_KEY) {
    res.status(500).json({
      error: "AI backend is not configured. Add OPENAI_API_KEY on the server."
    });
    return false;
  }
  return true;
}

async function openAI(prompt) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenAI request failed.");
  }

  // Responses API can contain multiple output items. Collect text safely.
  const text = (data.output || [])
    .flatMap(item => item.content || [])
    .filter(item => item.type === "output_text")
    .map(item => item.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("AI returned no text.");
  return text;
}

function parseJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("AI returned invalid identification data.");
  return JSON.parse(cleaned.slice(first, last + 1));
}

app.post("/api/identify-phone", async (req, res) => {
  if (!requireKey(res)) return;

  const phone = String(req.body?.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "Enter a phone model." });

  try {
    const prompt = `
You are the phone-identification engine for LuharSensi, a Free Fire sensitivity website.

User input: "${phone}"

Identify the exact smartphone model if you can do so confidently.
Rules:
- Normalize spelling, abbreviations and casual names.
- Do NOT invent a model.
- If multiple models are plausible, return verified=false.
- Do not use a generic family name when an exact model cannot be determined.
- iPhone and iPad are iOS/iPadOS and should have ios=true.
- For Android phones, give your best-known display refresh rate in Hz.
- Give performance and touch-response classes from 1-100 only when reasonably known; otherwise use conservative values and explain uncertainty in "note".
- confidence must be 0 to 1.
- Return ONLY valid JSON with these keys:
{
  "verified": boolean,
  "brand": string,
  "model": string,
  "ios": boolean,
  "confidence": number,
  "refresh": number,
  "performance": number,
  "touch": number,
  "note": string
}
`;

    const text = await openAI(prompt);
    const result = parseJson(text);

    if (!result.verified || !result.model || Number(result.confidence) < 0.75) {
      return res.json({
        verified: false,
        confidence: Number(result.confidence || 0),
        note: result.note || "Model could not be verified confidently."
      });
    }

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/assistant", async (req, res) => {
  if (!requireKey(res)) return;

  const question = String(req.body?.question || "").trim();
  const phone = req.body?.phone;
  const playstyle = String(req.body?.playstyle || "movement");
  const weapon = String(req.body?.weapon || "Mixed / All weapons");

  if (!question) return res.status(400).json({ error: "Type your gaming problem first." });

  try {
    const phoneText = phone
      ? `${phone.brand || ""} ${phone.model || ""}`.trim()
      : "No verified phone";

    const prompt = `
You are LuharSensi AI, a concise gaming-settings assistant.
User's verified phone: ${phoneText}
Playstyle: ${playstyle}
Main weapon: ${weapon}
User problem: ${question}

Give practical, safe Free Fire advice.
Do not promise guaranteed headshots.
Do not claim sensitivity can fix hardware/FPS problems.
Suggest changing only a small number of settings at a time and testing them.
Keep the answer under 120 words.
`;

    const answer = await openAI(prompt);
    res.json({ answer });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`LuharSensi running on port ${PORT}`);
});
