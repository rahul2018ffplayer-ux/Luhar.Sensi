const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));

/*
========================================================
 LuharSensi Device Cache
========================================================

The server remembers verified phone information while
the server is running.

Example:

"Tecno Spark 8C"
"tecno spark 8c"
"TECNO SPARK 8C"

all become:

"tecno spark 8c"
*/

const deviceCache = new Map();

/*
========================================================
 Rate limiter
========================================================

Only NEW/uncached phone verification requests count.

5 new phone verifications per IP per hour.
Cached phones are NOT limited.
*/

const verificationAttempts = new Map();

const MAX_NEW_VERIFICATIONS = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

/*
========================================================
 Common aliases
========================================================

Only safe/common spelling variations go here.
We do NOT blindly correct every typo.
*/

const PHONE_ALIASES = {
  "tecno sapar 8c": "tecno spark 8c",
  "tecno sparc 8c": "tecno spark 8c",
  "tecno spark8c": "tecno spark 8c"
};

/*
========================================================
 Normalize phone name
========================================================
*/

function normalizePhoneName(name) {
  let value = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[®™]/g, "")
    .replace(/\s+/g, " ");

  value = value.replace(/\s*-\s*/g, "-");

  if (PHONE_ALIASES[value]) {
    value = PHONE_ALIASES[value];
  }

  return value;
}

/*
========================================================
 Get client IP
========================================================
*/

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || "unknown";
}

/*
========================================================
 Rate-limit check
========================================================
*/

function canUseNewVerification(ip) {
  const now = Date.now();

  let attempts = verificationAttempts.get(ip) || [];

  attempts = attempts.filter(
    timestamp => now - timestamp < RATE_WINDOW_MS
  );

  if (attempts.length >= MAX_NEW_VERIFICATIONS) {
    verificationAttempts.set(ip, attempts);

    const oldest = attempts[0];
    const retryAfterMs = RATE_WINDOW_MS - (now - oldest);

    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000)
    };
  }

  attempts.push(now);
  verificationAttempts.set(ip, attempts);

  return {
    allowed: true,
    retryAfterSeconds: 0
  };
}

/*
========================================================
 OpenAI helper
========================================================
*/

async function openAI(prompt, options = {}) {
  if (!OPENAI_API_KEY) {
    throw new Error(
      "AI backend is not configured. Add OPENAI_API_KEY on the server."
    );
  }

  const body = {
    model: OPENAI_MODEL,
    input: prompt,

    /*
    Keep the response compact.
    This helps reduce token usage.
    */
    max_output_tokens: options.max_output_tokens || 1200
  };

  /*
  Optional web search.

  Only enable this when explicitly requested by the caller.
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
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data?.error?.message || "OpenAI request failed."
    );

    error.status = response.status;
    error.code = data?.error?.code;

    throw error;
  }

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

/*
========================================================
 JSON parser
========================================================
*/

function parseJson(text) {
  const cleaned = String(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first === -1 || last === -1 || last <= first) {
    throw new Error(
      "AI returned invalid identification data."
    );
  }

  return JSON.parse(
    cleaned.slice(first, last + 1)
  );
}

/*
========================================================
 Validate device information
========================================================

We NEVER accept a result as verified unless the model
identification is sufficiently confident.
*/

function validateDeviceResult(result, originalInput) {
  if (!result || typeof result !== "object") {
    return {
      verified: false,
      note: "The phone information could not be verified."
    };
  }

  const confidence = Number(result.confidence);

  if (
    result.verified !== true ||
    !result.brand ||
    !result.model ||
    !Number.isFinite(confidence) ||
    confidence < 0.80
  ) {
    return {
      verified: false,
      confidence: Number.isFinite(confidence)
        ? confidence
        : 0,
      note:
        result.note ||
        `The exact phone model "${originalInput}" could not be verified confidently.`
    };
  }

  const refresh = Number(result.refresh);
  const performance = Number(result.performance);
  const touch = Number(result.touch);
  const screenSize = Number(result.screenSize);

  return {
    verified: true,

    brand: String(result.brand).trim(),
    model: String(result.model).trim(),

    ios: Boolean(result.ios),

    confidence,

    chipset: result.chipset
      ? String(result.chipset).trim()
      : "Unknown",

    tier: result.tier
      ? String(result.tier).toLowerCase().trim()
      : "unknown",

    refresh: Number.isFinite(refresh) ? refresh : 60,

    performance:
      Number.isFinite(performance)
        ? Math.max(1, Math.min(100, performance))
        : 50,

    touch:
      Number.isFinite(touch)
        ? Math.max(1, Math.min(100, touch))
        : 50,

    screenSize:
      Number.isFinite(screenSize)
        ? screenSize
        : null,

    note: result.note
      ? String(result.note).trim()
      : "Verified device information."
  };
}

/*
========================================================
 IDENTIFY PHONE
========================================================
*/

app.post("/api/identify-phone", async (req, res) => {
  const originalInput = String(
    req.body?.phone || ""
  ).trim();

  if (!originalInput) {
    return res.status(400).json({
      verified: false,
      error: "Enter a phone model."
    });
  }

  const normalized = normalizePhoneName(originalInput);

  /*
  ------------------------------------------------------
  STEP 1 — CACHE
  ------------------------------------------------------
  */

  const cached = deviceCache.get(normalized);

  if (cached) {
    console.log(
      `[CACHE HIT] ${originalInput} → ${cached.brand} ${cached.model}`
    );

    return res.json({
      ...cached,
      cached: true
    });
  }

  console.log(
    `[NEW PHONE] ${originalInput} → ${normalized}`
  );

  /*
  ------------------------------------------------------
  STEP 2 — RATE LIMIT
  ------------------------------------------------------
  */

  const ip = getClientIp(req);

  const rate = canUseNewVerification(ip);

  if (!rate.allowed) {
    return res.status(429).json({
      verified: false,
      rateLimited: true,
      error:
        "Too many new phone verification requests. Please try again later.",
      retryAfterSeconds: rate.retryAfterSeconds
    });
  }

  /*
  ------------------------------------------------------
  STEP 3 — AI VERIFICATION
  ------------------------------------------------------
  */

  try {
    const prompt = `
You are the phone verification engine for LuharSensi.

User entered:
"${originalInput}"

Normalized search name:
"${normalized}"

Your job is to identify the EXACT smartphone model.

IMPORTANT:
- Do NOT guess.
- Do NOT invent specifications.
- Do NOT turn an uncertain family name into an exact model.
- Case differences must not matter.
- Common spelling variations may be understood.
- If you cannot confidently identify the exact model, return verified=false.
- Verify the model before giving specifications.
- If information conflicts, prefer reliable manufacturer information.
- Do not create specifications just to complete the request.

Return ONLY valid JSON.

Required format:

{
  "verified": true,
  "brand": "exact brand",
  "model": "exact model",
  "ios": false,
  "confidence": 0.95,
  "chipset": "exact chipset",
  "tier": "low",
  "refresh": 60,
  "performance": 40,
  "touch": 45,
  "screenSize": 6.6,
  "note": "short verification note"
}

Rules for confidence:
- 0.90 to 1.00 = highly confident
- 0.80 to 0.89 = reasonably confident
- below 0.80 = verified must be false

Rules for tier:
- low
- mid
- high
- gaming

Performance and touch are relative 1-100 classifications,
not benchmark scores.

If exact specifications are unavailable or uncertain,
do not invent them.

Keep the JSON compact.
`;

    const text = await openAI(prompt, {
      max_output_tokens: 1200
    });

    const rawResult = parseJson(text);

    const result = validateDeviceResult(
      rawResult,
      originalInput
    );

    /*
    ----------------------------------------------------
    Do not cache failed verification.
    ----------------------------------------------------
    */

    if (!result.verified) {
      console.log(
        `[NOT VERIFIED] ${originalInput}`
      );

      return res.json({
        ...result,
        cached: false
      });
    }

    /*
    ----------------------------------------------------
    SAVE VERIFIED DEVICE
    ----------------------------------------------------
    */

    deviceCache.set(normalized, result);

    console.log(
      `[CACHED] ${normalized} → ${result.brand} ${result.model}`
    );

    return res.json({
      ...result,
      cached: false
    });

  } catch (err) {
    console.error(
      "[PHONE VERIFICATION ERROR]",
      err.message
    );

    /*
    ----------------------------------------------------
    OpenAI rate limit
    ----------------------------------------------------
    */

    if (
      err.status === 429 ||
      /rate limit/i.test(err.message) ||
      /tokens per minute/i.test(err.message) ||
      /TPM/i.test(err.message)
    ) {
      return res.status(429).json({
        verified: false,
        rateLimited: true,
        error:
          "AI verification is temporarily rate-limited. No phone specifications were guessed.",
        note:
          "Please try this phone again later."
      });
    }

    return res.status(502).json({
      verified: false,
      error:
        "The phone could not be verified right now.",
      note:
        "No sensitivity was generated from unverified phone data."
    });
  }
});

/*
========================================================
 AI ASSISTANT
========================================================
*/

app.post("/api/assistant", async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      error:
        "AI backend is not configured. Add OPENAI_API_KEY on the server."
    });
  }

  const question = String(
    req.body?.question || ""
  ).trim();

  const phone = req.body?.phone;

  const playstyle = String(
    req.body?.playstyle || "movement"
  );

  const weapon = String(
    req.body?.weapon || "Mixed / All weapons"
  );

  if (!question) {
    return res.status(400).json({
      error:
        "Type your gaming problem first."
    });
  }

  try {
    const phoneText = phone
      ? `${phone.brand || ""} ${phone.model || ""}`.trim()
      : "No verified phone";

    const phoneDetails = phone
      ? `
Chipset: ${phone.chipset || "Unknown"}
Device tier: ${phone.tier || "Unknown"}
Refresh rate: ${phone.refresh || "Unknown"} Hz
Performance class: ${phone.performance || "Unknown"}/100
Touch class: ${phone.touch || "Unknown"}/100
`
      : "";

    const prompt = `
You are LuharSensi AI.

Give practical Free Fire settings advice.

VERIFIED PHONE:
${phoneText}

${phoneDetails}

PLAYSTYLE:
${playstyle}

WEAPON PREFERENCE:
${weapon}

USER'S QUESTION:
${question}

Rules:
- Use the verified phone information when relevant.
- Do not pretend unknown specifications are known.
- Do not promise guaranteed headshots.
- Do not claim sensitivity can fix hardware limitations.
- Do not automatically recommend high DPI.
- If the phone is low-end, prioritize stability and responsiveness rather than extreme values.
- Only recommend changing DPI when there is a reasonable reason.
- Suggest changing a small number of settings at a time.
- Explain what the user should test.
- Avoid repeating generic advice if the question contains a specific problem.
- Answer directly.
- Keep the answer under 150 words.
`;

    const answer = await openAI(prompt, {
      max_output_tokens: 900
    });

    return res.json({
      answer
    });

  } catch (err) {
    console.error(
      "[ASSISTANT ERROR]",
      err.message
    );

    if (
      err.status === 429 ||
      /rate limit/i.test(err.message) ||
      /tokens per minute/i.test(err.message) ||
      /TPM/i.test(err.message)
    ) {
      return res.status(429).json({
        error:
          "AI is temporarily rate-limited. Please try again later."
      });
    }

    return res.status(502).json({
      error:
        "The AI assistant could not respond right now."
    });
  }
});

/*
========================================================
 Health check
========================================================
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "LuharSensi",
    cachedDevices: deviceCache.size
  });
});

/*
========================================================
 START SERVER
========================================================
*/

app.listen(PORT, () => {
  console.log(
    `LuharSensi running on port ${PORT}`
  );
});
