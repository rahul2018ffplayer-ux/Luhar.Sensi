# LuharSensi v7 — AI phone identification

This version removes the hardcoded phone list from the browser.

## What changed

- Users can type phone names naturally, including spelling variations.
- The browser sends the phone name to `/api/identify-phone`.
- The server asks the AI to identify the exact model.
- Low-confidence/unknown models are rejected instead of receiving random settings.
- iPhone/iPad detection hides the Android-style DPI recommendation.
- The AI gaming assistant is available at `/api/assistant`.
- The OpenAI key stays on the server; it is NOT placed in `index.html`.

## Run locally

Requires Node.js 18+.

```bash
npm install
```

Set your environment variable:

Windows PowerShell:
```powershell
$env:OPENAI_API_KEY="YOUR_KEY"
```

Optional model:
```powershell
$env:OPENAI_MODEL="gpt-5.6-luna"
```

Then:

```bash
npm start
```

Open:
http://localhost:3000

## Important

The AI can identify a phone, but an AI model should not be treated as a perfect hardware-spec database. For production accuracy, the next upgrade should add a verified phone-spec API/database after the AI identifies the canonical model. That lets LuharSensi use verified refresh rate/chipset/touch/display information instead of relying on AI's remembered specs.

Do not put `OPENAI_API_KEY` in frontend JavaScript, HTML, or a public Git repository.
