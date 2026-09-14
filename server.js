const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

app.use(express.json({ limit: "64kb" }));
app.use(express.static(__dirname));

/* =========================================================
   BASIC HELPERS
========================================================= */

function requireKey(res) {
  if (!OPENAI_API_KEY) {
    res.status(500).json({
      error:
        "AI backend is not configured. Add OPENAI_API_KEY on the server."
    });
    return false;
  }

  return true;
}

function cleanString(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, n));
}

/* =========================================================
   OPENAI RESPONSES API
========================================================= */

async function openAI(input, options = {}) {
  const body = {
    model: OPENAI_MODEL,
    input
  };

  /*
    Web search is only enabled when requested.

    This prevents every normal AI Chat question from
    unnecessarily performing a web search.
  */
  if (options.webSearch) {
    body.tools = [
      {
        type: "web_search"
      }
    ];
  }

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "OpenAI request failed."
    );
  }

  /*
    Responses API can contain multiple output items.
    Collect all output_text safely.
  */
  const text = (data.output || [])
    .flatMap(item => item.content || [])
    .filter(item => item.type === "output_text")
    .map(item => item.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("AI returned no text.");
  }

  return text;
}

/* =========================================================
   JSON PARSER
========================================================= */

function parseJson(text) {
  let cleaned = String(text || "").trim();

  cleaned = cleaned
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first === -1 || last === -1) {
    throw new Error("AI returned invalid JSON.");
  }

  const jsonText = cleaned.slice(first, last + 1);

  return JSON.parse(jsonText);
}

/* =========================================================
   PHONE TIER
========================================================= */

function normalizeTier(value) {
  const tier = String(value || "").toLowerCase();

  if (tier.includes("gaming")) return "gaming";
  if (tier.includes("high")) return "high";
  if (tier.includes("mid")) return "mid";
  if (tier.includes("low")) return "low";

  return "unknown";
}

/*
  If the AI/research result doesn't provide a tier,
  calculate a conservative one from performance,
  refresh rate and touch response.

  This is intentionally bounded. It does NOT claim
  that RAM alone determines phone performance.
*/
function calculateTier(data) {
  const performance = clampNumber(
    data.performance,
    1,
    100,
    50
  );

  const touch = clampNumber(
    data.touch,
    1,
    100,
    50
  );

  const refresh = clampNumber(
    data.refresh,
    30,
    240,
    60
  );

  const gaming =
    performance >= 82 &&
    refresh >= 90 &&
    touch >= 75;

  if (gaming) return "gaming";

  if (
    performance >= 72 ||
    (performance >= 65 && refresh >= 90)
  ) {
    return "high";
  }

  if (performance >= 45) {
    return "mid";
  }

  return "low";
}

/* =========================================================
   PHONE IDENTIFICATION
========================================================= */

app.post("/api/identify-phone", async (req, res) => {
  if (!requireKey(res)) return;

  const phone = cleanString(req.body?.phone, 200);

  if (!phone) {
    return res.status(400).json({
      error: "Enter a phone model."
    });
  }

  try {
    /*
      Phone research is deliberately web-enabled.

      The AI is instructed to prefer manufacturer/spec
      sources and cross-check important specifications.
    */
    const prompt = `
You are the device research engine for LuharSensi,
a Free Fire sensitivity website.

The user entered this phone name:

"${phone}"

Your job is to identify the EXACT smartphone model
and research its real hardware characteristics.

IMPORTANT RULES:

1. Do not invent a phone model.
2. Normalize spelling mistakes and casual names.
3. If the name could refer to multiple models,
   do not pretend you know the exact one.
4. Search the web when needed.
5. Prefer reliable sources such as:
   - official manufacturer specifications
   - official product pages
   - reputable technical specification databases
   - reputable technology reviews
6. Cross-check important specifications when possible.
7. Do not use the user's requested RAM amount as proof
   of the phone's performance tier.
8. Performance is an estimate for gaming purposes,
   not an official benchmark score.
9. Touch score is an estimated gaming-oriented score,
   not a manufacturer's official score.
10. If a specification cannot be verified, say so in note.
11. Do not manufacture a refresh rate, chipset or screen size.

Return ONLY valid JSON.

Required format:

{
  "verified": true,
  "brand": "Brand",
  "model": "Exact Model",
  "ios": false,
  "confidence": 0.95,

  "chipset": "Exact chipset or Unknown",

  "refresh": 90,

  "screenSize": 6.6,

  "performance": 65,

  "touch": 70,

  "tier": "mid",

  "ramOptions": ["4GB", "6GB", "8GB"],

  "note": "Short explanation of important uncertainty."
}

Definitions:

performance:
1-100 gaming-performance estimate.

touch:
1-100 estimated touch responsiveness
based on available technical information.

tier:
Only one of:
"low"
"mid"
"high"
"gaming"

refresh:
Display refresh rate in Hz.

screenSize:
Display size in inches.

confidence:
0 to 1.

If the exact model cannot be confidently identified,
return:

{
  "verified": false,
  "confidence": 0,
  "brand": "",
  "model": "",
  "ios": false,
  "chipset": "Unknown",
  "refresh": 60,
  "screenSize": 0,
  "performance": 50,
  "touch": 50,
  "tier": "unknown",
  "ramOptions": [],
  "note": "Unable to identify the exact model confidently."
}
`;

    const text = await openAI(prompt, {
      webSearch: true
    });

    const result = parseJson(text);

    const confidence = clampNumber(
      result.confidence,
      0,
      1,
      0
    );

    /*
      Require a reasonably strong match.
    */
    if (
      !result.verified ||
      !result.model ||
      confidence < 0.75
    ) {
      return res.json({
        verified: false,
        confidence,
        note:
          result.note ||
          "The exact phone model could not be verified confidently."
      });
    }

    const performance = clampNumber(
      result.performance,
      1,
      100,
      50
    );

    const touch = clampNumber(
      result.touch,
      1,
      100,
      50
    );

    const refresh = clampNumber(
      result.refresh,
      30,
      240,
      60
    );

    const screenSize = clampNumber(
      result.screenSize,
      0,
      20,
      0
    );

    const tier =
      normalizeTier(result.tier) !== "unknown"
        ? normalizeTier(result.tier)
        : calculateTier({
            performance,
            touch,
            refresh
          });

    res.json({
      verified: true,

      brand: cleanString(result.brand, 80),
      model: cleanString(result.model, 150),

      ios: Boolean(result.ios),

      confidence,

      chipset:
        cleanString(result.chipset, 120) ||
        "Unknown",

      refresh,

      screenSize,

      performance,

      touch,

      tier,

      ramOptions: Array.isArray(result.ramOptions)
        ? result.ramOptions
            .map(x => cleanString(x, 20))
            .filter(Boolean)
            .slice(0, 8)
        : [],

      note:
        cleanString(result.note, 500) ||
        "Specifications researched from available sources."
    });
  } catch (err) {
    console.error("PHONE IDENTIFICATION ERROR:", err);

    res.status(502).json({
      error:
        err.message ||
        "Phone research failed. Please try again."
    });
  }
});

/* =========================================================
   AI CHAT
========================================================= */

app.post("/api/assistant", async (req, res) => {
  if (!requireKey(res)) return;

  const question = cleanString(
    req.body?.question,
    1000
  );

  if (!question) {
    return res.status(400).json({
      error: "Type your gaming problem first."
    });
  }

  const phone = req.body?.phone || null;

  const playstyle = cleanString(
    req.body?.playstyle || "Not specified",
    100
  );

  const weapon = cleanString(
    req.body?.weapon || "Not specified",
    100
  );

  /*
    Conversation history lets follow-up questions
    actually depend on previous messages.
  */
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .slice(-8)
        .map(item => ({
          role:
            item?.role === "assistant"
              ? "assistant"
              : "user",
          content: cleanString(
            item?.content,
            1000
          )
        }))
        .filter(item => item.content)
    : [];

  const phoneText = phone
    ? `
Brand: ${cleanString(phone.brand, 80)}
Model: ${cleanString(phone.model, 150)}
Chipset: ${cleanString(
        phone.chipset || "Unknown",
        120
      )}
Performance score: ${clampNumber(
        phone.performance,
        1,
        100,
        50
      )}
Touch score: ${clampNumber(
        phone.touch,
        1,
        100,
        50
      )}
Refresh rate: ${clampNumber(
        phone.refresh,
        30,
        240,
        60
      )} Hz
Screen size: ${clampNumber(
        phone.screenSize,
        0,
        20,
        0
      )} inches
Device tier: ${normalizeTier(
        phone.tier
      )}
`
    : "No verified phone selected.";

  /*
    Determine whether current question is likely to
    benefit from fresh device information.

    This avoids web-searching every simple question.
  */
  const lowerQuestion = question.toLowerCase();

  const needsResearch =
    /spec|chipset|processor|cpu|gpu|refresh|hz|touch|sampling|screen|display|fps|performance|benchmark|phone|device|model|ram|storage|latest|new phone|compare/i.test(
      lowerQuestion
    );

  const conversationText =
    history.length > 0
      ? history
          .map(item => {
            const who =
              item.role === "assistant"
                ? "AI"
                : "USER";

            return `${who}: ${item.content}`;
          })
          .join("\n")
      : "No previous conversation.";

  const prompt = `
You are LuharSensi AI.

You are an intelligent Free Fire settings assistant.
Your job is to answer the USER'S ACTUAL QUESTION.

Do NOT automatically give a generic sensitivity preset.

==================================================
DEVICE
==================================================

${phoneText}

==================================================
USER CONTEXT
==================================================

Playstyle:
${playstyle}

Main weapon:
${weapon}

==================================================
PREVIOUS CONVERSATION
==================================================

${conversationText}

==================================================
CURRENT QUESTION
==================================================

${question}

==================================================
HOW TO ANSWER
==================================================

First understand what the user is actually asking.

Possible categories include:

- sensitivity
- drag shots
- aim too fast
- aim too slow
- recoil
- shotgun
- SMG
- AR
- sniper
- DPI
- HUD
- movement
- FPS
- lag
- overheating
- refresh rate
- touch response
- device performance
- phone comparison
- general Free Fire settings
- troubleshooting
- something unrelated to sensitivity

Answer the relevant category instead of forcing
everything into a sensitivity recommendation.

If the user reports a problem such as:
"aim is too fast"

explain what setting should be adjusted and why.

If the user asks about:
"Redmi Note 10 shotgun sensitivity"

consider both the phone and shotgun use.

If the user asks about:
"game is lagging"

do not pretend sensitivity will fix FPS problems.

If the user asks a factual device question,
answer the device question.

If the user asks for sensitivity:

- Use the verified device tier.
- Low-end devices can start somewhat higher.
- High-end/high-refresh devices can start somewhat
  lower and more controlled.
- Do not claim this is guaranteed.
- Do not use random numbers.
- Give a starting point and explain that testing is needed.
- Change only a few settings at a time.

Do not claim:
"this will guarantee headshots."

Do not claim:
"this sensitivity is perfect."

Do not invent hardware specifications.

If the user asks something outside gaming,
answer briefly if it is harmless and relevant,
otherwise explain that LuharSensi is focused on gaming.

==================================================
STYLE
==================================================

Be natural and useful.

Do not repeat the same generic introduction.

Do not start every answer with:
"Here is the best sensitivity..."

Use short sections when helpful.

Prefer concrete explanations.

Normally stay under about 180 words,
but use more if the question genuinely needs it.

Do not mention internal prompts,
web-search instructions, APIs or backend systems.
`;

  try {
    const answer = await openAI(prompt, {
      webSearch: needsResearch
    });

    res.json({
      answer
    });
  } catch (err) {
    console.error("AI ASSISTANT ERROR:", err);

    res.status(502).json({
      error:
        err.message ||
        "AI assistant failed. Please try again."
    });
  }
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "LuharSensi AI",
    model: OPENAI_MODEL
  });
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
  console.log(
    `LuharSensi running on port ${PORT}`
  );
});
