# CIVIC — main page prototype

The functional main page: paste or upload text, CIVIC extracts every empirical claim, tests the
first 20 in parallel, and shows each determination (True / False / Unverified) with the full
encyclopedia-style entry, a live scoreboard, a challenge panel per result, and a reset.

```
civic-web/
├── server/            Node + Express. Holds the prompts. Proxies the reader's key to OpenAI.
│   ├── prompts/       The vault. Real prompts live here (gitignored) or in env vars. See its README.
│   ├── config.js      Models, efforts, limits, feature flags (all overridable by env vars).
│   ├── extract.js     Step 1: streaming claim extraction, claims parsed as they arrive.
│   ├── evaluate.js    Step 2: 20 claims in parallel, verdict parsing, per-claim streaming.
│   ├── illustrate.js  Visual echo (fast image model, reader's key).
│   ├── challenge.js   Challenge mechanics; the OpenAI call is withheld until certified.
│   └── documents.js   .pdf / .docx / text parsing for uploads.
├── public/            The page. No build step. Plain ES modules.
│   ├── index.html · css/civic.css
│   ├── js/app.js      State machine and UI. js/api.js streaming client. js/demo.js sample run.
│   ├── js/i18n.js     Translation layer. locales/en.js es.js fr.js de.js (add more here).
│   └── assets/        Logos (background knocked out) and the scene.
└── scripts/           mock-openai.js (dev stand-in for OpenAI), build-artifact.mjs (static preview).
```

## Run it

```bash
cd civic-web
npm install
# put the prompts in place (never committed):
cp server/prompts/extract.example.txt server/prompts/extract.txt     # then paste the real prompt
cp server/prompts/evaluate.example.txt server/prompts/evaluate.txt   # must contain {{CLAIM}}
npm start            # http://localhost:3000
```

Readers add their own OpenAI key on the page (stored in their browser only). Every request sends
it in a header; the server never stores it.

### Without a key (development)

```bash
npm run mock-openai                                   # terminal 1: fake OpenAI on :3999
OPENAI_BASE_URL=http://localhost:3999/v1 npm start    # terminal 2
```

Any key starting with `sk-` works against the mock; keys starting with `sk-bad` are rejected, to
exercise the error path. The page also has a **sample run** (button under the main action, or
`/?demo=1`) that needs no server at all.

## First real run and internal accounting

```bash
npm start                                            # terminal 1 (prompts installed as above)
OPENAI_API_KEY=sk-... node scripts/trial-run.mjs doc.txt --limit 3   # terminal 2
node scripts/ledger-summary.mjs                      # cost of goods sold so far
```

`trial-run.mjs` streams a document through both steps exactly as the page does and prints, per
claim, the verdict, tokens (input / output / reasoning), searches, duration and estimated cost,
then the run totals. Start with `--limit 3` to see timing and cost before spending on 20.

Every call is also appended to `data/ledger.jsonl` (gitignored): kind, model, effort, token
usage, searches, duration, verdict and a short hash of the claim — never the claim text or a key.
The page shows the same figures per card and a run total behind an **Internal** chip while
`CIVIC_INTERNAL_ACCOUNTING=true`; set it to `false` for customers. Dollar figures come from the
table in `server/pricing.js`; token counts come from the API and are exact.

The first 20 claims always run. Claims beyond 20 are listed with checkboxes; the reader picks
all or some and runs them as an extra batch once the first batch has finished.

## Prompt protection

The prompts are the product. The design keeps them out of every place a reader could look:

- They are loaded once at startup from env vars or gitignored files and kept in server memory.
  Nothing under `server/` is served as a file. No API response contains prompt text.
- Every OpenAI request is sent with `store: false`, so the key owner cannot open their OpenAI
  dashboard logs and read the prompt back. This matters because the key belongs to the reader.
- Prompt text is never logged. `server/prompts.js` also redacts it from `console.error` if a
  library ever tried to print it.
- The only text added around the author's prompt is a one-line developer instruction asking for a
  final `VERDICT: True | False | Unverified` line, which the server strips before display. The
  author's prompt is sent verbatim, claim substituted for `{{CLAIM}}`.

When accounts arrive, the reader's key should move server-side (encrypted at rest), and the prompts
should move to a secrets manager rather than files on disk.

## Models

| Step | Default | Why |
|---|---|---|
| Extraction | `gpt-5.6-terra`, effort `medium` | Careful reading over long documents, streams quickly, about a tenth of Sol's price. `gpt-5.6-luna` is the budget alternative. |
| Determination | `gpt-5.6-sol`, effort `xhigh`, web search on | As requested. Web search lets the inspector reach primary sources. |
| Visual echo | `gpt-image-2.5-flare`, quality `low` | OpenAI's fastest image model (September 2026). Falls back to `gpt-image-1-mini`. |

Model ids fall back down the list automatically if the key does not have access to the first one.
The scoreboard shows total tokens per run so cost can be estimated per document.

## Deploy

Any Node host works (Render, Railway, Fly.io, a VPS). Set the env vars from `.env.example`, put the
prompts in env vars or a mounted secrets file, and run `npm start`. Long reasoning runs stream for
minutes; keep the host's idle timeout above 10 minutes for the API routes, or terminate TLS with a
proxy that honours the server's heartbeat lines.

## Adding a language

Create `public/locales/xx.js` (copy `en.js`), import it in `public/js/i18n.js`, and add it to
`LOCALES` with its native name and text direction. Plural forms use `key_one` / `key_other`.
