# CIVIC — main page prototype

The functional main page: paste or upload text, CIVIC extracts every empirical claim, tests the
first ten, three at a time, and shows each determination (True / False / Unverified) with the full
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
├── server/            Node + Express. Holds the prompts and the operator's key. Nothing else has either.
│   ├── fetchurl.js    Reading a link: article, PDF or YouTube caption track, into the source's own words.
│   ├── prompts/       The vault. Real prompts live here (gitignored) or in env vars. See its README.
│   ├── config.js      Models, efforts, limits, feature flags (all overridable by env vars).
│   ├── extract.js     Step 1: streaming claim extraction, claims parsed as they arrive.
│   ├── evaluate.js    Step 2: ten claims, three at a time, verdict read from the Conclusion, streaming.
│   ├── illustrate.js  Visual echo: art direction, then the fast image model.
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

`npm start` reads the `.env` file in this folder (gitignored; see `.env.example`). Put the
operator's key there as `OPENAI_API_KEY`. That file is CIVIC's configuration and wins over a
variable of the same name in the environment, so a stale shell variable cannot quietly take over.

**CIVIC runs on the operator's key and on no other.** A key offered by a browser is ignored
outright: there is no key box on the page, no key is stored there, and nothing a reader sends can
choose the key. This is the first requirement of the product, not a convenience. A prompt run on
someone else's key is a prompt handed to them: it travels to OpenAI under their account, appears in
whatever that account retains, and any error it raises can quote the prompt back. `store: false`
narrows that exposure but does not remove it, and it was never the operator's to accept on a
stranger's account. `npm run verify` reads the Authorization header of every request the server
actually sent and fails if any of them carried a key offered by a browser.

**The port is CIVIC's.** When `npm start` finds an older CIVIC still holding the port, it closes
it and takes the port over, so an update can never leave yesterday's process answering with
today's files underneath it. A CIVIC is recognised by where it runs from and which Node it runs
on, never by its name. Anything else on the port is left alone and named in the Terminal window.
The version stamp shown in the page footer, on `/check`, in `/api/health` and in the Terminal
covers the page and the server alike, so which CIVIC is running is never a matter of belief.
`CIVIC_OPEN_BROWSER=1 npm start` opens the browser once CIVIC is actually answering; the Mac
launcher sets it.

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
performed, every source cited, plus duration and estimated cost, then the run totals (token
figures are in the ledger, never in the stream). It also writes the whole run to a `.md` and a `.json` file. Start with
`--limit 3` to see timing and cost before spending on 20; add `--quiet` for the table only.

Every call is also appended to `data/ledger.jsonl` (gitignored): kind, model, effort, token
usage, searches, duration, verdict and a short hash of the claim — never the claim text or a key.
The page shows the estimated cost per card and per run behind an **Internal** chip while
`CIVIC_INTERNAL_ACCOUNTING=true`; set it to `false` for customers. Token figures never reach the
page. Dollar figures come from the table in `server/pricing.js`; token counts come from the API
and are exact, in the ledger.

The first ten claims always run. Claims beyond ten are listed with checkboxes, and the reader
can choose among them; the button that would test the chosen ones is parked for now (the
operator's rule of 18 September, cost control until there is revenue against it) and says so.
Once the first ten are tested, **Create report** appears beside **Start a new test**; it is
parked the same way until the report is designed.

Each sign-in code allows a number of runs: `CIVIC_CODE_USES` (five) unless the code's own entry
in `CIVIC_ACCESS_CODES` names one (`ABCD234:150`). A run is counted when its extraction starts;
past the allowance the run is refused with the figures, in a sentence on the page. The count is
a file (`CIVIC_USES_FILE`), read at start, so a restart or a deploy forgets nothing when the file
is on a persistent disk; /check lists each code's runs used and allowed.

## Reading a link

A reader can paste a web address into the box instead of text. The server fetches it and puts the
source's own words in the box, where they can be read before anything is tested:

| Address | What comes back |
|---|---|
| An article or any web page | The page's prose, with scripts, styles, navigation, headers and footers removed |
| A PDF | Its text, through the same parser used for uploads |
| A YouTube video | The video's caption track, cues rejoined into sentences; the video itself, or its thumbnail, in the picture's box |
| A plain text or JSON file | The file |

No link is refused by its shape. A link from a Google app (`google.com/goto?url=…`) is a token that
only Google can resolve, and Google resolves it for any client as it does for a browser, so it is
tried like any other link and read where it leads; what a site then answers (its text, a refusal,
silence, a paywall, a shell) gets the same treatment as any other link. `google.com/url?q=…` carries
its destination in the open, and Google answers a plain client with a notice page rather than a
redirect, so the destination is read directly. A page with no prose whose markup sends the browser
elsewhere (a meta refresh) is followed like a redirect, within the same limit of hops. While a link is
read, its host and the seconds tick under the box, and a read that fails keeps its sentence there.
"That address could not be reached." reaches the reader without jargon; the cause (a code such as
`ECONNREFUSED`) goes to /check's recent failures. A read the page abandons is recorded as nothing.

Many news sites keep their text from a server. Probed from the service on 18 September: seven of
twelve major sites refuse a server within a second (NYT, Reuters, AP, WSJ, Bloomberg, Politico, the
Economist), the Washington Post takes the connection and never answers the request, the Atlantic
answers with an empty shell, and four give their text (BBC, CNN, CNBC, the Guardian). Each case is
named to the reader by the site, with what to do (copy the article's text and paste it): a refusal
at the door (401, 403, 429); silence (no answer to the connection attempt, or none to the request
once connected: either is found in the platform's own ten seconds, undici's connect timeout and its
headers timeout set to the same figure in server/http.js, never the operating system's minute;
remembered until the service restarts so the next reader is told at once, re-checked in the
background whenever it is asked for again, and listed on /check); a paywall (the page marks
the article as not free with the schema.org flag Google News reads, or its prose says so at the
wall, or it answers 402): when the page sent no paragraph of prose, the sentence; when it sent prose,
the text goes into the box marked, with the sentence that the site marks the article as for
subscribers, and the reader decides whether it is the whole article before pressing the button
(the operator's rule of 19 September; the run does not start by itself in this one case); a shell
(no paragraph of prose, under 200 characters at most). The page's sentences are in four languages.

### Formulas in a determination

The model sometimes writes a formula as mathematics. Markdown reads a line holding only `=` or only
`-` as an underline for the line above, so a formula pasted straight into the page lost its operators
and turned its terms into headings. Each formula (`\[…\]`, `$$…$$`, `\(…\)`) is therefore parked
under a name Markdown cannot touch before the text is formatted (`splitMath` in `public/js/render.js`),
put back after the sanitiser, and typeset by KaTeX, which is served from `node_modules` like the other
two browser libraries. A lone dollar sign is never mathematics, because the model writes sums of
money. A formula the typesetter cannot read stays exactly as the model wrote it: nothing is dropped
and nothing is shown as an error.

Nothing is summarised, shortened or rewritten. When a video has no written transcript, YouTube's
automatic captions are used and the page says so, because they contain transcription errors.
Captions carry no speaker labels, so a multi-speaker transcript arrives as continuous text.
The track is read through YouTube's player API the way its Android app asks (since 2026 the web
player's caption files answer empty to a server: they need a proof-of-origin token only a browser can
make), with the public key and the visitor id the watch page itself embeds; nothing is configured.
YouTube's player has several doors (the Android app's, the TV app's, the embedded player's, the VR
app's, the iPhone app's) and guards them unevenly, so they are asked in turn (`CIVIC_YOUTUBE_CLIENTS`)
until one answers with captions. A video shut at every door gets "YouTube would not show this video's
captions to CIVIC's server without a sign-in, as it does for some videos. Open the video on YouTube,
choose Show transcript under the description, copy the text and paste it here.", with each door's
answer on /check; a video with no captions at an open door says so.

When every door is shut and the operator has set a hosted transcript service (`CIVIC_TRANSCRIPT_URL`
and `CIVIC_TRANSCRIPT_KEY`, with `CIVIC_TRANSCRIPT_HEADER` and `CIVIC_TRANSCRIPT_PREFIX` for how the
key is carried and `CIVIC_TRANSCRIPT_JOB_URL` for where a job's result is read), CIVIC asks it as the
last door. No vendor is named in the code: the address takes `{id}` and `{url}`, the answer is read
for whichever shape it has, a single piece of text or a list of pieces, and a service that hands back
a job while it makes the transcript is followed to the end of that job, with no time limit of CIVIC's
own. Most services carry the key raw in a header of their own, so the prefix is empty unless one is
named. `.env.example` holds the four values for Supadata, the service the operator uses. With nothing
set, nothing is asked and the sentence above stands. The key is a
server setting like the OpenAI key: it never reaches the browser and never appears in a failure
record. There is no key for transcripts from Google — the YouTube Data API's caption download works
only on videos the key holder owns, needs the owner's sign-in, and never covers automatic captions —
which is why these services exist and charge per call.

While a video's test runs, its player sits in
the picture's box (320 by 180 beside the steps, full width on a phone), or its thumbnail with a link
when the owner allows no embedding; no picture is generated for a video. `CIVIC_YOUTUBE_BASE` lets
the guard stand in for YouTube.

Addresses that resolve inside a private network are refused, so a public CIVIC server cannot be
aimed at machines behind its own firewall. `CIVIC_ALLOW_PRIVATE_URLS=true` lifts that for local
development only.

## Sources as tools

The model can reach for CIVIC's own tools while it works, through the gateway at `/mcp` (the open
standard, MCP, over HTTP). The gateway is CIVIC's server itself; OpenAI's servers call it during a
response, with a pass CIVIC issues (`CIVIC_TOOLS_PASS`), and the model's call is answered at once.
The requests name it with one entry in the existing `tools` list beside web search, and nothing
else changes: the prompts go byte for byte, and whether the model calls a tool is the model's
decision. With `CIVIC_TOOLS_URL` or the pass unset, the requests are exactly as before and the
gateway answers no one.

The tools are **verbs**, few and stable (`server/tools/verbs.js`): `read_page` and
`get_transcript` today; `search_law`, `get_case`, `search_filings`, `get_financials`,
`search_news` as those domains arrive. The **sources** behind them are adapters
(`server/tools/adapters/`, one file each, with a stand-in beside it for the guard): the web, read by
CIVIC's own link reader with all of its rules, is the first; a legal or financial database is one
more file, its key and its address as settings, and nothing else in the program names it. A source
is on when its settings are set; a verb is listed when a source answers it; a verb several sources
answer gains a `source` parameter the model must fill, listing each source in its own words, so the
model chooses the source and CIVIC's code never does. Every source answers in one shape (title,
site, address, date, the text, and where it came from), whole, with the source's own next page as
a cursor when it has one. What a source keeps back (a refusal, a paywall, a silence) reaches the
model as the reader's own sentence, information for its analysis, never as the claim's failure.
Each call is one line in the ledger, priced at the operator's figure for that source, and the row
on the page shows it in the trail like a search. The words the model reads for every verb and
source are printed by `npm run tools`; they are the operator's text, like the prompts.

## What is sent, exactly

Every request to OpenAI carries the operator's tested configuration and nothing else. There is no
number in this program in the path of a determination that the operator did not set.

**Extraction request:** `model`, `input` (the extraction prompt, verbatim, with the source in
place of its final bracketed line, as the only message), `reasoning.effort`, `reasoning.mode`, `reasoning.summary`,
`tools` (one `web_search`, no options; and, when the gateway is set, one `mcp` entry naming it, with `server_label`, `server_url`, `headers` carrying the pass and `require_approval: never`, nothing else), `stream`, `store`. The source goes into that slot with
what CIVIC knows of its attribution, since the slot asks for it: for a link, the page's title,
author, site, date and address and the day CIVIC read it; for a file, its name and the day; for
pasted text, the day it was pasted and that nothing else was given. Nothing is guessed. A prompt
without a final bracketed line is sent as `instructions` instead, with the text alone as the only
message. The reply is read as a numbered list; in each entry the text under a `Claim:` label is
what is tested, and any further labelled lines are shown beside it, verbatim.

**Determination request:** `model`, `input` (two messages: first the source exactly as the
extractor received it, its attribution lines and its text; then the evaluation prompt, verbatim,
with the claim's whole entry, Claim, Attribution and Unspecified lines, in place of `{{CLAIM}}`),
`reasoning.effort`, `reasoning.mode`, `reasoning.summary`, `tools` (one `web_search`, no options; and, when the gateway is set, one `mcp` entry naming it, with `server_label`, `server_url`, `headers` carrying the pass and `require_approval: never`, nothing else), `stream`,
`store`. The source goes ahead because the conversation carried it in the workflow the prompts
were tested in; a claim tested bare, "the speech" with no speaker or date, was being tested
without the context the extraction prompt had written for it.

Nothing else. No output token cap. No reasoning mode. No verbosity. No search context size. No
truncation setting. No fallback model. No size limit of ours on the document.

| Setting | Value | Set by |
|---|---|---|
| Model, both steps | `gpt-5.6-sol` | Operator, tested |
| Reasoning effort, both steps | `max` | Operator, 21 September: the model's maximum power below GPT-6 (tested at `xhigh` before that) |
| Reasoning mode, both steps | `pro` | Operator, 21 September: GPT-5.6's pro mode, OpenAI's "highest-intelligence API option" short of GPT-6; more model work per answer at the same per-token rates. `standard` or blank sends no mode key. |
| Web search | on, both steps, not configurable | The prompts were tested in a UI where search is available to every prompt. A request without it is not what was tested. |
| Reasoning summary | `auto` | Display only: the model's own account of its reasoning, shown on the card. Does not change the answer. Blank to turn off. |
| Claims run automatically | 10, three at a time, each on its own request; the rest wait for the reader's selection. The page is told the figure by the server (`CIVIC_EVAL_CONCURRENCY`, reported as `inFlight` on `/api/health`), so the pace changes with one setting and no release | Operator's rule |
| Sign-in | Off unless `CIVIC_ACCESS_CODES` is set (comma-separated seven-character codes). Then every API route but the health line needs the cookie a listed code earns: the page's Sign in opens a dialog for an email address and a code; only the code is checked, the email is kept with the sign-in and listed on /check. A cookie is bound to the code it was issued under, so taking a code off the list signs out its holders and nobody else. Nothing is counted and nothing locks. | Operator's rule; accounts come later |
| Pacing | OpenAI keeps a bucket of the key's minute limit that refills continuously at that limit per minute; each request costs what OpenAI estimates for it, and a request the bucket cannot hold is refused with exactly the wait that refills the difference (its refusals say so, to the millisecond). CIVIC reads those figures from every reply and sends one request at a time: the next goes only after the previous reply's headers have been read, and only when the bucket holds its cost. What each kind of request costs is learned from OpenAI's exact figures alone: a request sent into a full minute, or a refusal. /check shows the figures. | OpenAI's own numbers |
| Rate limits | Never a failure, never an error on a row. A refusal at the door sets the bucket to OpenAI's figures; the refused request waits exactly what OpenAI asked and goes first. A refusal can also arrive inside a running reply, when the response's own later call (after a web search) finds the minute short and OpenAI ends the response with its figures in an error event: it is read the same way, the claim waits exactly what OpenAI asked, and goes again whole. This is why claims run three at a time rather than twenty: a running reply is charged again at each of its later calls (67,000 to 89,000 each), by far more than its admission showed, so many parallel claims starve one another; three need about 450,000 in a typical minute against the key's 2,000,000-a-minute limit (read from the check page on 18 September; it was 500,000 on 16 September). Four ran from 18 September; three again from 22 September, because effort `max` in mode `pro` is more model work per claim and the wider margin is worth having. The figure is a setting, so it moves without a release. A used-up quota is reported in words. | OpenAI's own numbers |
| Retries | None counted on a connection that could not be made or was cut: that is the operating system's report ("no route to host", "connection refused", "connection reset"), never OpenAI's, and nothing was decided by it. The claim waits for the connection and goes again a second after the failed go began, however long the route is missing; a go that finds no route costs nothing. The row says why it waits, in the system's words, and /check records the outage with its start, its cause, its length and the machine's addresses at the time. 8 on a 5xx, which costs nothing. No back-off of ours: a failed attempt rejoins the line at the gate, and OpenAI's own retry-after, when given, comes first. | Never on a model or parameter error |
| Time limits | None of ours, on either step or on reading a link. An extraction of a very long document or a determination at a high effort takes as long as it takes; a connection the network reports dead is made again, not counted as a failure. | Operator's rule |

Environment variables: `CIVIC_MODEL`, `CIVIC_EFFORT` (both steps), or per step
`CIVIC_EXTRACT_MODELS`, `CIVIC_EXTRACT_EFFORT`, `CIVIC_EVAL_MODELS`, `CIVIC_EVAL_EFFORT`,
`CIVIC_EXTRACT_REASONING_SUMMARY`, `CIVIC_EVAL_REASONING_SUMMARY`. There is no setting that
removes web search.
The server prints the exact shape of both requests at startup.

The image is a picture, not a determination, and the operator asked for the fast model there
(`CIVIC_IMAGE_*`).

### When something goes wrong

```
http://localhost:3000/check
```

Asks the server what is wrong and answers in sentences: whether both prompts are installed, whether
a key is configured, whether OpenAI accepts that key, and whether the key may use the configured
model. The model check reads the model's description rather than running it, so it spends nothing.
Each failure carries the step that fixes it, and the page lists recent failures from both the server
and the browser, so a message that has already disappeared can still be read. Nothing secret is
recorded: keys are redacted and no prompt or document text is kept.

A failure during a run also stays on the page until the next run, rather than appearing briefly in
a message that vanishes.

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
- Every OpenAI request is sent with `store: false`, so the prompt is not retained for the account
  that pays for it.
- Requests run only on the operator's key. A reader's key is never accepted, so a prompt is never
  carried into an account the operator does not control.
- Error text on its way back to a browser is scanned for prompt text and redacted, because an API
  can quote part of a request inside an error message.
- Prompt text is never logged. `server/prompts.js` also redacts it from `console.error` if a
  library ever tried to print it.
- Nothing is added to the author's prompt. No system instruction, no verdict tag, no formatting
  note. The extraction prompt is sent as the instructions field verbatim; the evaluation prompt is
  sent as the sole user message with the claim substituted for `{{CLAIM}}`, and nothing else.
  The verdict is read afterwards from the model's own Conclusion section.

When accounts arrive, the prompts should move to a secrets manager rather than files on disk.

## Models

| Step | Default | Why |
|---|---|---|
| Extraction | `gpt-5.6-sol`, effort `max`, mode `pro`, web search on | The operator's configuration, the same as for determination. |
| Determination | `gpt-5.6-sol`, effort `max`, mode `pro`, web search on | As requested. Web search lets the inspector reach primary sources, and every query and citation is shown. |
| Art direction | `gpt-5.6-luna`, effort `low` | Reads the document and writes a concrete photographic brief for the echo. About two seconds. |
| Visual echo | `gpt-image-2.5-flare`, quality `high` | OpenAI's fastest image model. Quality is `high`, not `low`: the speed comes from the model, not from starving it. |

One model id per step means no fallback. Only if the operator lists several ids in
`CIVIC_EXTRACT_MODELS` or `CIVIC_EVAL_MODELS` does the server move down the list, and only when the
key cannot use the earlier id; when that happens the page shows a warning naming both models.
The scoreboard shows the three counts and, with internal accounting on, the run's estimated cost.
No token figure appears anywhere on the page or in what the page receives (the operator's rule of
18 September); the ledger keeps OpenAI's usage per request.

### Why the echo looks the way it does

An image model handed raw document text returns something generic. Stage one therefore reads the
document and writes a specific brief — subject, setting, foreground, light, palette, lens — and
stage two makes that brief as an edit of the CIVIC photograph (the page's own background,
`public/assets/civic-scene-1920.jpg`), attached to every request as the style reference: the model
takes only how that picture is made and none of what it shows, and no text, charts or symbols
appear anywhere in the result (the operator's rule of 18 September). Every echo therefore uploads
that file (531 KB) and OpenAI bills its image input tokens, which the ledger line records as
`usage`; the flat per-image estimate is `CIVIC_IMAGE_USD_PER_IMAGE`.
Set `CIVIC_IMAGE_ART_DIRECTION=false` to send raw text instead and see the difference. For more
fidelity at the cost of time, put `gpt-image-2.5-sunburst` first in `CIVIC_IMAGE_MODELS` or raise
`CIVIC_IMAGE_QUALITY` to `xhigh`.

## Deploy without a terminal

The repository root carries `render.yaml`, which lets [Render](https://render.com) build and
run the server straight from GitHub, and `docs/cloud.md` holds the whole plan and its state.

The `civic` service exists and runs at `https://civic-c64i.onrender.com`; it was created through
Render's API with the settings below, and it redeploys from `main`. To create it again elsewhere:

1. Render must be able to fetch the repository: either the repository is public, or the Render
   account's Git Deployment Credential (Account Settings → Account Security) is a GitHub account
   that can see it. Installing Render's GitHub app on the organisation is not enough on its own.
2. New → Blueprint → choose the repository and `main`. Render reads `render.yaml` and creates the
   `civic` service. (The same service can be created through Render's API with the same settings.)
3. Open the service → Environment. Under Secret Files add `extract.txt` (the extraction prompt)
   and `evaluate.txt` (the evaluation prompt, which must contain the token `{{CLAIM}}`). Under
   Environment Variables set `OPENAI_API_KEY` (the operator's key, the only one the service will
   ever use) and `CIVIC_ACCESS_CODES` (the codes that open the door, comma-separated). Save.
4. Deploy. The service gets an address like `https://civic-xxxx.onrender.com`. Open it, press
   Sign in, enter a code, paste a document, press Test the facts.

The prompts live only in Render's secret store and the server's memory; they are never in the
repository. The internal ledger and the sign-in log are written to a temporary disk and do not
persist between deploys; Render's own log stream keeps the sign-in lines.

Each claim is tested on its own request, so no response outlasts one claim (Render allows a
response 100 minutes). The work itself belongs to the server, not to the connection
(`server/jobs.js`): every extraction and every determination is a job under an id the page made,
and the reply is a stream of the job's events. A connection that is cut on the way (a browser's
network, a relay such as iCloud Private Relay, which cut a finished four-minute extraction on
18 September) stops nothing: the page opens a new connection a second later, says how many events
it already has, and receives the rest; the step line or the row reads "The connection to CIVIC
was cut · going again" meanwhile. Nothing is run twice and nothing is paid for twice. Only the
page stops a job: Start a new test and leaving the page send a cancel. A deploy ends the process
that was running, and with it its jobs: `/api/health` reports `active`, the runs in flight
whatever their connections are doing, an update is merged only when that is zero, and a claim
cut by a deploy anyway starts over on the new process.

## Deploy anywhere else

Any Node host works (Railway, Fly.io, a VPS). Set the env vars from `.env.example`, put the
prompts in env vars or a mounted secrets file, and run `npm start`.

## Adding a language

Create `public/locales/xx.js` (copy `en.js`), import it in `public/js/i18n.js`, and add it to
`LOCALES` with its native name and text direction. Plural forms use `key_one` / `key_other`.
