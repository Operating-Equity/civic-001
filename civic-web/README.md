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
│   ├── js/app.js      State machine and UI. js/api.js streaming client. js/render.js markdown, toasts.
│   ├── js/i18n.js     Translation layer. locales/en.js es.js fr.js de.js (add more here).
│   └── assets/        Logos (background knocked out) and the scene.
└── scripts/           verify.mjs (the guard), mock-openai.js (dev stand-in), trial-run.mjs, ledger-summary.mjs.
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

`npm start` also reads a `.env` file in this folder if one exists (gitignored; see `.env.example`).
Settings already present in the environment win over the file. Two ways to supply the key:

- **Operator's key.** Put `CIVIC_ALLOW_SERVER_KEY=true` and `OPENAI_API_KEY=sk-...` in `.env` or the
  environment. The page then asks no one for a key.
- **Reader's key.** Leave those unset. Readers add their own OpenAI key on the page (stored in
  their browser only). Every request sends it in a header; the server never stores it.

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

## What is sent, exactly

Every request to OpenAI carries the operator's tested configuration and nothing else. There is no
number in this program in the path of a determination that the operator did not set.

**Extraction request:** `model`, `instructions` (the extraction prompt, verbatim), `input` (the
document, whole, as the only message), `reasoning.effort`, `reasoning.summary`, `tools` (one
`web_search`, no options), `stream`, `store`.

**Determination request:** `model`, `input` (the evaluation prompt, verbatim, with the claim in
place of `{{CLAIM}}`, as the only message), `reasoning.effort`, `reasoning.summary`, `tools`
(one `web_search`, no options), `stream`, `store`.

Nothing else. No output token cap. No reasoning mode. No verbosity. No search context size. No
truncation setting. No fallback model. No size limit of ours on the document.

| Setting | Value | Set by |
|---|---|---|
| Model, both steps | `gpt-5.6-sol` | Operator, tested |
| Reasoning effort, both steps | `xhigh` | Operator, tested |
| Web search | on, both steps, not configurable | The prompts were tested in a UI where search is available to every prompt. A request without it is not what was tested. |
| Reasoning summary | `auto` | Display only: the model's own account of its reasoning, shown on the card. Does not change the answer. Blank to turn off. |
| Claims run automatically | 20; the rest wait for the reader's selection | Operator's rule |
| Retries | 8, on rate limits and 5xx only | Never on a model or parameter error |

Environment variables: `CIVIC_MODEL`, `CIVIC_EFFORT` (both steps), or per step
`CIVIC_EXTRACT_MODELS`, `CIVIC_EXTRACT_EFFORT`, `CIVIC_EVAL_MODELS`, `CIVIC_EVAL_EFFORT`,
`CIVIC_EXTRACT_REASONING_SUMMARY`, `CIVIC_EVAL_REASONING_SUMMARY`. There is no setting that
removes web search.
The server prints the exact shape of both requests at startup.

The image is a picture, not a determination, and the operator asked for the fast model there
(`CIVIC_IMAGE_*`).

### The guard

```bash
npm run verify
```

Starts the mock and the server, runs both steps, and reads the request bodies the server
**actually sent**. It also scans every file git tracks for any five-word run of the installed
prompts and fails if one is found, so no template, comment or test fixture can carry prompt text
into the repository (`npm run leak-check` runs that scan on its own). It fails if a request carries any key beyond the list above, if the model or
effort differ from the configuration, if either prompt is not byte-for-byte verbatim, if a
fallback or truncation occurred, if any streamed character is missing from the delivered text, or
if a verdict was read from anywhere but the model's own Conclusion. Run it before every deploy.
A non-zero exit is a defect, whoever introduced it.

### What surfaces instead of being absorbed

- A document the model cannot hold is refused by the API and that error is shown verbatim.
  Nothing is ever read in part.
- A key that cannot use the configured model gets an error, not a quieter model.
- A parameter the model rejects is an error with the API's own message, not a silent change.
- An entry the API ends early is flagged on the card with the API's reason.
- A Conclusion that cannot be read leaves the claim counted in no column, with the entry shown
  in full.

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
| Extraction | `gpt-5.6-sol`, effort `xhigh`, web search on | The operator's tested configuration, the same as for determination. |
| Determination | `gpt-5.6-sol`, effort `xhigh`, web search on | As requested. Web search lets the inspector reach primary sources, and every query and citation is shown. |
| Art direction | `gpt-5.6-luna`, effort `low` | Reads the document and writes a concrete photographic brief for the echo. About two seconds. |
| Visual echo | `gpt-image-2.5-flare`, quality `high` | OpenAI's fastest image model. Quality is `high`, not `low`: the speed comes from the model, not from starving it. |

One model id per step means no fallback. Only if the operator lists several ids in
`CIVIC_EXTRACT_MODELS` or `CIVIC_EVAL_MODELS` does the server move down the list, and only when the
key cannot use the earlier id; when that happens the page shows a warning naming both models.
The scoreboard shows total tokens per run so cost can be estimated per document.

### Why the echo looks the way it does

An image model handed raw document text returns something generic. Stage one therefore reads the
document and writes a specific brief — subject, setting, foreground, light, palette, lens — and
stage two draws that brief in one fixed house style taken from the CIVIC photograph: a documentary
frame in natural light, people at ordinary scale, and no text, charts or symbols anywhere in it.
Set `CIVIC_IMAGE_ART_DIRECTION=false` to send raw text instead and see the difference. For more
fidelity at the cost of time, put `gpt-image-2.5-sunburst` first in `CIVIC_IMAGE_MODELS` or raise
`CIVIC_IMAGE_QUALITY` to `xhigh`.

## Deploy without a terminal

The repository root carries `render.yaml`, which lets [Render](https://render.com) build and
run the server straight from GitHub:

1. Sign up at render.com with your GitHub account and allow it to see `Operating-Equity/civic-001`.
2. New → Blueprint → choose the repository and the branch. Render reads `render.yaml` and creates
   the `civic` service.
3. Open the service → Environment. Under Secret Files add `extract.txt` (the extraction prompt)
   and `evaluate.txt` (the evaluation prompt, which must contain the token `{{CLAIM}}`). Under Environment
   Variables paste your OpenAI key as the value of `OPENAI_API_KEY`. Save.
4. Deploy. The service gets an address like `https://civic.onrender.com`. Open it, paste a
   document, press Test the facts. The page asks no one for a key; the server uses yours.

The prompts live only in Render's secret store and the server's memory; they are never in the
repository. The internal ledger on Render is written to a temporary disk and does not persist
between deploys; set `CIVIC_LEDGER_FILE` to a persistent disk path if you attach one.

Long determinations stream for many minutes. Verify the plan you choose does not cut idle HTTP
connections; the server sends a heartbeat line every 15 seconds to keep them open.

## Deploy anywhere else

Any Node host works (Railway, Fly.io, a VPS). Set the env vars from `.env.example`, put the
prompts in env vars or a mounted secrets file, and run `npm start`.

## Adding a language

Create `public/locales/xx.js` (copy `en.js`), import it in `public/js/i18n.js`, and add it to
`LOCALES` with its native name and text direction. Plural forms use `key_one` / `key_other`.
