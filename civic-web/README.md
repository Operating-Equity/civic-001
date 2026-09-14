# CIVIC — main page prototype

The functional main page: paste or upload text, CIVIC extracts every empirical claim, tests the
first 20 in parallel, and shows each determination (True / False / Unverified) with the full
encyclopedia-style entry, a live scoreboard, a challenge panel per result, and a reset.

Two rules the code exists to keep:

1. **Nothing runs that was not submitted.** There is no sample, no seeded text, no demo mode and
   no preloaded result anywhere in the product. The page is empty until a document is given to it.
2. **Nothing the model returns is edited, trimmed or withheld.** The prompts are sent verbatim.
   The entry is rendered whole. The reasoning summary, every web search performed and every source
   cited are on the card, and the raw text is one click away. There is no output token cap by
   default. The verdict is read out of the model's own Conclusion section — when it cannot be read,
   the card says so and the claim is counted in no column rather than defaulting to Unverified.

```
civic-web/
├── server/            Node + Express. Holds the prompts. Proxies the reader's key to OpenAI.
│   ├── prompts/       The vault. Real prompts live here (gitignored) or in env vars. See its README.
│   ├── config.js      Models, efforts, limits, feature flags (all overridable by env vars).
│   ├── extract.js     Step 1: streaming claim extraction, claims parsed as they arrive.
│   ├── evaluate.js    Step 2: 20 claims in parallel, verdict read from the Conclusion, streaming.
│   ├── illustrate.js  Visual echo: art direction, then the fast image model, on the reader's key.
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
exercise the error path. `MOCK_NO_SUMMARY=1` makes it reject reasoning summaries, to exercise that
fallback. The mock is the only place in this repository that contains invented determinations, and
it is never served to the page in production.

## First real run and internal accounting

```bash
npm start                                            # terminal 1 (prompts installed as above)
OPENAI_API_KEY=sk-... node scripts/trial-run.mjs doc.txt --limit 3   # terminal 2
node scripts/ledger-summary.mjs                      # cost of goods sold so far
```

`trial-run.mjs` streams a document through both steps exactly as the page does and prints
everything that comes back: the complete entry for every claim, the reasoning summary, every search
performed, every source cited, plus tokens (input / output / reasoning), duration and estimated
cost, then the run totals. It also writes the whole run to a `.md` and a `.json` file. Start with
`--limit 3` to see timing and cost before spending on 20; add `--quiet` for the table only.

Every call is also appended to `data/ledger.jsonl` (gitignored): kind, model, effort, token
usage, searches, duration, verdict and a short hash of the claim — never the claim text or a key.
The page shows the same figures per card and a run total behind an **Internal** chip while
`CIVIC_INTERNAL_ACCOUNTING=true`; set it to `false` for customers. Dollar figures come from the
table in `server/pricing.js`; token counts come from the API and are exact.

The first 20 claims always run. Claims beyond 20 are listed with checkboxes; the reader picks
all or some and runs them as an extra batch once the first batch has finished.

**Download full run** on the scoreboard writes one Markdown file containing the source, the
verbatim extraction output, and every entry with its reasoning, searches, sources and costs.

## Every place money could be traded for truth

This is the complete list. Anything in the code that limits, shortens, cheapens or substitutes is
named here, with what it can cost and who chose it. If something is not on this list, it does not
exist in the code.

| Setting | What it can cost | Default | Chosen by |
|---|---|---|---|
| `CIVIC_EVAL_MODELS` first entry | The whole determination | `gpt-5.6-sol` | You |
| `CIVIC_EVAL_EFFORT` | Depth of the inspection | `xhigh` (`max` exists above it) | You |
| `CIVIC_EVAL_WEB_SEARCH` | Access to primary sources | `true` | Default |
| `CIVIC_EVAL_MAX_OUTPUT_TOKENS` | A cut-off entry | `0`, no cap | Default |
| `CIVIC_EXTRACT_MODELS` first entry | Claims missed at step 1 and never recoverable | `gpt-5.6-terra` | Proposed, you agreed |
| `CIVIC_EXTRACT_EFFORT` | Same | `medium` | Proposed, you agreed |
| `CIVIC_EXTRACT_MAX_OUTPUT_TOKENS` | A cut-off claim list | `0`, no cap | Default |
| `CIVIC_MAX_SOURCE_CHARS` | Nothing: over-length documents are refused, not cut | `2,000,000` | Default |
| `CIVIC_ALLOW_SOURCE_TRUNCATION` | Unread text, announced in red when on | `false` | Default |
| `maxClaims` (hard-coded) | Claims 21+ wait for your selection | `20` | You |
| `CIVIC_EVAL_RETRIES` | Nothing; retries only on rate limits and 5xx | `3` | Default |
| `CIVIC_EVAL_CONCURRENCY` | Nothing; speed only | `20` | Default |
| `CIVIC_EVAL_REASONING_SUMMARY` | Costs extra tokens, buys visibility | `auto` | Default |
| Image model, quality, art direction | Picture only. Never touches a determination. | flare / high / on | Default |

**Step 1 is the weakest link, by design and by my recommendation.** A claim the extractor misses is
never tested, and no amount of `xhigh` at step 2 recovers it. Extraction currently runs on Terra at
medium effort because it is reading, not judging, and because it costs about a tenth of Sol. If you
want the whole pipeline at maximum:

```bash
CIVIC_EXTRACT_MODELS=gpt-5.6-sol CIVIC_EXTRACT_EFFORT=xhigh CIVIC_EVAL_EFFORT=max npm start
```

Compare the two extraction outputs on the same document. The verbatim extraction output is on the
page under **Extraction output, verbatim**, so the comparison is exact rather than impressionistic.

### What the code refuses to do quietly

- **A document longer than the limit is refused**, with the exact overflow named. It is never
  partly read with nothing said. Truncation is opt-in and, when on, is announced in red at the top
  of the run with the exact number of characters that went unread.
- **A model downgrade is announced.** If the key cannot use the first-choice model, the run shows a
  red warning, every card names the model that actually answered, and the ledger records it. The
  fallback trigger is narrow: only an error naming the model as unavailable. An unsupported
  parameter, such as a reasoning effort the model does not accept, surfaces as an error instead of
  silently switching to a weaker model.
- **An unreadable Conclusion is not rounded to Unverified.** The card says the verdict could not be
  read and the claim is counted in no column.
- **An entry cut short by the API is flagged** on the card with the reason.

## Prompt protection

The prompts are the product. The design keeps them out of every place a reader could look:

- They are loaded once at startup from env vars or gitignored files and kept in server memory.
  Nothing under `server/` is served as a file. No API response contains prompt text.
- Every OpenAI request is sent with `store: false`, so the key owner cannot open their OpenAI
  dashboard logs and read the prompt back. This matters because the key belongs to the reader.
- Prompt text is never logged. `server/prompts.js` also redacts it from `console.error` if a
  library ever tried to print it.
- Nothing is added to the author's prompt. No system instruction, no verdict tag, no formatting
  note. The extraction prompt is sent as the instructions field verbatim; the evaluation prompt is
  sent as the sole user message with the claim substituted for `{{CLAIM}}`, and nothing else.
  The verdict is read afterwards from the model's own Conclusion section.

When accounts arrive, the reader's key should move server-side (encrypted at rest), and the prompts
should move to a secrets manager rather than files on disk.

## Models

| Step | Default | Why |
|---|---|---|
| Extraction | `gpt-5.6-terra`, effort `medium` | Careful reading over long documents, streams quickly, about a tenth of Sol's price. `gpt-5.6-luna` is the budget alternative. |
| Determination | `gpt-5.6-sol`, effort `xhigh`, web search on | As requested. Web search lets the inspector reach primary sources, and every query and citation is shown. |
| Art direction | `gpt-5.6-luna`, effort `low` | Reads the document and writes a concrete photographic brief for the echo. About two seconds. |
| Visual echo | `gpt-image-2.5-flare`, quality `high` | OpenAI's fastest image model. Quality is `high`, not `low`: the speed comes from the model, not from starving it. |

Model ids fall back down the list automatically if the key does not have access to the first one.
The scoreboard shows total tokens per run so cost can be estimated per document.

### Why the echo looks the way it does

An image model handed raw document text returns something generic. Stage one therefore reads the
document and writes a specific brief — subject, setting, foreground, light, palette, lens — and
stage two draws that brief in one fixed house style taken from the CIVIC photograph: a documentary
frame in natural light, people at ordinary scale, and no text, charts or symbols anywhere in it.
Set `CIVIC_IMAGE_ART_DIRECTION=false` to send raw text instead and see the difference. For more
fidelity at the cost of time, put `gpt-image-2.5-sunburst` first in `CIVIC_IMAGE_MODELS` or raise
`CIVIC_IMAGE_QUALITY` to `xhigh`.

## Deploy

Any Node host works (Render, Railway, Fly.io, a VPS). Set the env vars from `.env.example`, put the
prompts in env vars or a mounted secrets file, and run `npm start`. Long reasoning runs stream for
minutes; keep the host's idle timeout above 10 minutes for the API routes, or terminate TLS with a
proxy that honours the server's heartbeat lines.

## Adding a language

Create `public/locales/xx.js` (copy `en.js`), import it in `public/js/i18n.js`, and add it to
`LOCALES` with its native name and text direction. Plural forms use `key_one` / `key_other`.
