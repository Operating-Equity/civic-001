# FactEngine (formerly CIVIC) — main page prototype

The functional main page: paste or upload text, FactEngine extracts every empirical claim, lists them with
checkboxes, runs the ones the reader chooses ten at a time (or the first `CIVIC_AUTO_TEST_FIRST` of them
without a press, when that setting is above 0), and shows each determination (True / False / Unverified)
with the full encyclopedia-style entry, a live scoreboard, and a reset.

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
│   ├── copies.js      A link FactEngine cannot read: a search service's reader, else copies for the reader to pick from.
│   ├── prompts/       The vault. Real prompts live here (gitignored) or in env vars. See its README.
│   ├── config.js      Models, efforts, limits, feature flags (all overridable by env vars).
│   ├── economics.js   Facts have a price: the tiers, the price from the measured average, the loss guard, the books.
│   ├── db.js          Render's Postgres (DATABASE_URL), where the measurement outlives every deploy; migrations/ holds the schema.
│   ├── extract.js     Step 1: streaming claim extraction, claims parsed as they arrive.
│   ├── evaluate.js    Step 2: the claims, ten at a time, verdict read from the Conclusion, streaming.
│   ├── illustrate.js  Visual echo: art direction, then the fast image model.
│   ├── assets.js      The page's files as they are sent: without comments, the page in the operator's form or a reader's.
│   └── documents.js   .pdf / .docx / text parsing for uploads.
├── public/            The page. No build step. Plain ES modules.
│   ├── index.html · css/civic.css
│   ├── js/app.js      State machine and UI. js/api.js streaming client. js/render.js markdown, toasts.
│   ├── js/field.js    The mathematics behind the glass: ten drawn fields that change with the run (field-worker.js draws the fractals).
│   ├── js/i18n.js     Translation layer. locales/en.js es.js fr.js de.js (add more here).
│   └── assets/        Logos, the favicon, the fonts, and the style-reference photograph for the echo.
└── scripts/           verify.mjs (the guard), mock-openai.js (dev stand-in), trial-run.mjs, ledger-summary.mjs.
```

## The look: clear glass over mathematics

The page is one light theme, by the operator's rule of 2 October: light and never dark, because light
clears darkness and reveals truth; glass, because truth has two factors, light and transparency. Every
panel is clear glass (`css/civic.css`: `--glass`, `--glass-strong`, `--glass-blur`, `--glass-shine`), and
behind the glass sits a drawn field of mathematics rather than a photograph (`js/field.js`; no picture
file is loaded). Ten fields of four kinds, each built from its own definition when it is shown: four
proofs typeset by KaTeX (Euclid's infinitude of primes, the irrationality of √2, Euclid I.47 as the
windmill figure, Euler's identity); the golden rectangle and its spiral; the fractals (the Mandelbrot set
and a Julia set, drawn by `js/field-worker.js` off the page's thread, and the Koch snowflake); chaos and
primes (the Lorenz attractor, a double pendulum's trace, the Ulam spiral). The field is fixed to the
window, so every panel has it behind it at any scroll depth, and it changes with the run: a visit opens
on one field, extraction shifts to a second, testing to a third and done settles on a fourth, by one of
two decks drawn at random once per visit. The three fractal fields drift in slowly; `prefers-reduced-motion`
stops that and makes every change instant. The field is decoration only: hidden from screen readers,
inert, never reading matter, and nothing about it is stored or sent. Its ink stays faint (large forms at
or under .2 alpha over the ground, thin strokes to .3), so body text on the strong glass keeps a contrast
of 14 : 1 and hints 4.7 : 1. The check page holds the golden rectangle still. The verdicts keep their own
colours on every surface: true green, false red, unverified grey (the grey zone: strong but conflicting evidence,
nothing dirty about it, the operator's rule of 2 October); a verdict the page could not read is dashed and hollow,
a different thing. The amber is for cautions only (a card's note, the check page's warning mark). There is one box type,
rounded, and no corner brackets (the operator's rule of 2 October: the brackets made the page busy). The footer
names the site and whose service it is ("A service of Fact Engine LLC, an Operating Equity company"), and carries
the pages a commercial service owes, Terms, Privacy, Refunds and Contact (`public/terms.html`, `privacy.html`,
`refunds.html`, `contact.html`: the operator's launch texts of 3 October, in English, static HTML in `.prose` over
the still field, their placeholders in square brackets theirs to fill), and the year. The four open in a new tab,
because leaving the page cancels a run in progress. Under the results, one sentence in the reader's language says
that determinations are made by an AI model from the sources it cites and can be wrong.

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
operator's key there as `OPENAI_API_KEY`. That file is FactEngine's configuration and wins over a
variable of the same name in the environment, so a stale shell variable cannot quietly take over.

**FactEngine runs on the operator's key and on no other.** A key offered by a browser is ignored
outright: there is no key box on the page, no key is stored there, and nothing a reader sends can
choose the key. This is the first requirement of the product, not a convenience. A prompt run on
someone else's key is a prompt handed to them: it travels to OpenAI under their account, appears in
whatever that account retains, and any error it raises can quote the prompt back. `store: false`
narrows that exposure but does not remove it, and it was never the operator's to accept on a
stranger's account. `npm run verify` reads the Authorization header of every request the server
actually sent and fails if any of them carried a key offered by a browser.

**The port is FactEngine's.** When `npm start` finds an older FactEngine still holding the port, it closes
it and takes the port over, so an update can never leave yesterday's process answering with
today's files underneath it. A FactEngine is recognised by where it runs from and which Node it runs
on, never by its name. Anything else on the port is left alone and named in the Terminal window.
The version stamp shown in the page footer, on `/check`, in `/api/health` and in the Terminal
covers the page and the server alike, so which FactEngine is running is never a matter of belief.
`CIVIC_OPEN_BROWSER=1 npm start` opens the browser once FactEngine is actually answering; the Mac
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

How long the model takes is measured too: the operator's check page reports, over the price window, the mean and the
75th percentile of a determination's and a listing's duration and the web searches per determination, from the
ledger's own lines (the times run from the request to its end, so a wait at the gate is inside them). These are the
figures to decide the extraction's effort by, which the operator kept at `max` in `pro` on 3 October pending them.

How many claims run without a press is `CIVIC_AUTO_TEST_FIRST` (10 unless set). The rest are listed with checkboxes, and the reader
chooses which to test; **Test N selected claims** runs the whole selection as one batch, ten at a time (`CIVIC_EVAL_CONCURRENCY`), the next claim starting as one ends. With the setting at 0 nothing
runs by itself: every claim found is shown with its checkbox, numbered from one, and the page's own sentences say so.

## Facts have a price; every user is measured

The operator's program of 2 October, in their words: "All empirical facts are parsed and listed for Free,
and the user can then decide which or all to test, with 0 to 3 free facts, and cost and revenue measured
for all users in each tier"; "the average needs to be marked up 25% to start"; "change every 6 hours
unless one is very unprofitable and I am losing a lot of money. Become 1 until we earn it back"; "I need
to test, measure, and optimize." On 6 October: "It looks like facts cost around $1 to check, all in, to be safe", then
"Remove all pricing from the application except the list price, which doesn't need to be stated in every empirical
statement ... each fact-check is $1.25", and "The formula is going to test and return either 0, 1, or 2 answers, not
3". `server/economics.js` does exactly that and nothing else:

- **Listing is free; testing costs the list price.** Every claim found is listed. A run's **tier** is fixed when its
  extraction starts and holds for that document: tier 1 prices every claim; tiers 2 and 3 give the first one or
  two claims the reader chooses free (a tier 4 in the order would give three). The tiers rotate every
  `CIVIC_TIER_HOURS` (6) in `CIVIC_TIER_ORDER` (1,2,3 since 6 October; 1,2,3,4 before), and each day the rotation
  starts `CIVIC_TIER_SHIFT` (1) tiers later, so every tier meets every time of day; `CIVIC_TIER_FIXED` holds one
  tier for everyone.
- **One list price** for everyone and every window: `CIVIC_LIST_PRICE_CENTS` (125 on the service: $1.25, the
  operator's $1 marked up 25 %). Unset, nothing is priced. A window's row holding another price (the 49 cents
  the retired start figure fixed) takes the list price the first time it is asked, so a new price applies from
  the deploy that brings it; a document listed before keeps the price it was told. The average cost of a
  determination is still measured (its own ledger line: the provider's token counts at the price table, plus its
  searches) over `CIVIC_PRICE_WINDOW_DAYS` (7), for /check alone, where the list price's **coverage** of that cost
  plus `CIVIC_PRICE_MARKUP_PERCENT` (25) is shown; it never sets the price. `CIVIC_PRICE_START_CENTS` and
  `CIVIC_PRICE_MIN_SAMPLE`, the measured price's settings, are read by nothing since 6 October; the boot line and
  /check name them while they are still on the service. `CIVIC_CURRENCY` (USD) names the money.
- **The loss guard**: `CIVIC_TIER_LOSS_GUARD_USD` (unset = off). When the current window's margin falls
  below minus that figure, every new run goes to tier 1, the switch is recorded, and tier 1 holds until
  the margin earned since covers the loss; then the rotation resumes.
- **The books.** Revenue is booked at list price for every priced determination that reaches done, marked
  not collected until payments exist; a free one books nothing and counts as given; a failed one (an
  error, a stop, a deploy) keeps its cost, books nothing and never uses up a free one. The extraction's
  cost stays on the run as the cost of listing, apart. Margin is revenue less the determinations' cost;
  coverage is revenue against cost plus the markup, so 1.00 means the tokens and the 25 % are both covered.
- **The page** says the price once, in one line above the claims: "Each fact-check is $1.25. The first two you
  choose on this document are free." (the second sentence only when the document has free ones), then
  `CIVIC_PRICING_NOTE` when set. No claim's row carries a price or a Free mark, and the button says how many
  ("Test 3 selected claims"), never what they cost. A selection the balance cannot cover holds the button back with
  "Your balance covers three fact-checks. Choose three or fewer." (the document's free ones and as many as the
  balance pays for; never a total). The balance itself is in the menu bar. The server decides what is free, never
  the page: each determination is told its quote before the model is asked. A reader is told the tier, the free
  count and the price, and never a cost.
- **The measurement** lives in Render's Postgres (`DATABASE_URL`, Render's own name; `server/db.js`,
  the schema in `server/migrations/`, applied once at boot under an advisory lock), so nothing resets
  with a deploy: a row per run (owner, email, tier, price, free count, claims, listing cost), a row per
  determination (run, number, free or price, cost, searches, verdict, failure, collected), every ledger
  line with its ids, the windows and the guard events. Without `DATABASE_URL` the rows live in the
  instance's memory until it restarts. /check, for the operator alone, shows the list price and its coverage, the
  tier clock, the guard, the money per tier, per user and per window, and **how many fact-checks the key can run at
  once**: the key's own tokens a minute (OpenAI's figure, from the pacing row) over what one running determination
  takes of it, its mean tokens (read and written, cached included: OpenAI's minute counts them) over its mean
  minutes. The same figures go in the host's log at every boot, for the operator: `[capacity] last 7 days: n
  fact-checks, on average T tokens over M min (R a minute each)`, nothing of any reader's and no key.
- `CIVIC_PRICING_ENABLED=false` is the rollback: the page as before, nothing priced or measured beyond
  the ledger. `npm run verify` proves all of it on a real Postgres (a cluster of its own here; a service
  container in CI, where `CIVIC_VERIFY_REQUIRE_DATABASE=1` makes a missing database a failure).

## Accounts and credit

The operator, 5 October: "Get rid of access codes … We need to establish a sign-up and sign-on process first, followed
by payments. We don't need to worry about account funds; assume everyone who signs up gets $10 in their account." So
the door is an account, and a test is paid from the account's credit; payments, the last step, are not built.

- **Sign up and sign in** with an email address and a password, in a box on the page itself: no pop-up, and real form
  fields, so a password manager offers to save and fill them. An account comes before anything runs, the listing
  included. A refused press of Test the facts opens the box on Create account; the text stays in its box, and the run
  starts by itself once the account exists. No email is sent, so no address is verified, and nothing needs a domain.
- **Passwords** are kept only as scrypt hashes (N 2^14, r 8, p 5, a 16-byte salt: 16 MiB a hash, safe on Starter's
  512 MB), compared in constant time. An unknown email costs the same time as a wrong password and gets the same
  sentence. Wrong passwords are counted in memory per email (`CIVIC_SIGNIN_TRIES`, 10 an hour, then a wait until the
  hour has passed), and per address only when `CIVIC_SIGNIN_TRIES_PER_ADDRESS` is set; sign-ups per address a day only
  when `CIVIC_SIGNUPS_PER_ADDRESS_PER_DAY` is set. No address is stored.
- **Sessions:** the cookie `fe_session` carries 32 random bytes (HttpOnly, SameSite=Lax, Secure over HTTPS, for
  `CIVIC_SESSION_DAYS`, 400). The database keeps only the token's SHA-256, with its account, when it was made, when it
  was last seen (moved forward at most once an hour) and when it ends. Sign-out ends the session; a password change, a
  reset link and a block end every other one.
- **The door** (`server/access.js`): open are `/api/health` and the account's own doors (sign up, sign in, sign out, a
  reset link, the operator's link). Everything else needs a session (401 `signin_required`), and `/api/operator/*` the
  operator's (403). A request without a session is refused on its headers, before any body is read. A request another
  site's page makes is refused (Sec-Fetch-Site, or an Origin naming another host), and the account's and the operator's
  doors take JSON alone. `CIVIC_ACCOUNTS=off` opens the door, for a laptop of one's own and the guard's older checks;
  any other value, or none, keeps it shut, so a lost setting never opens it. On Render, accounts need `DATABASE_URL`:
  without it the service does not start, since accounts in memory would vanish at every deploy.
- **The operator's account** is made through a one-time link. The address in `CIVIC_OPERATOR_EMAILS` cannot be taken
  through the open form (it answers as any taken address does), because no address is verified; the link, whose SHA-256
  is `CIVIC_OPERATOR_CLAIM`, opens /account, makes the account with the operator's mark, and then opens nothing.
  /check, its script, its data and `/api/operator/*` are that account's alone: anyone else is told /check is not found.
  FactEngine's own costs (the cost chips, a job's cost line) reach the operator alone, and their words are in the
  operator's form of the page only.
- **Credit** (`server/credit.js`) is an append-only ledger, and the balance is its sum. A new account's grant
  (`CIVIC_SIGNUP_GRANT_CENTS`, 1000: $10) is written with the account. A priced test's price is held when it starts,
  in the same transaction that decides whether it is free, under a lock on the account, so two tabs cannot spend one
  balance twice. It is charged when its determination is delivered, and released when the test fails, is stopped, or
  is cut by a deploy; a hold settles once (a unique index). A test the balance cannot cover, or that would take this
  month's tests past the reader's own limit, is refused before any model is asked (402 `credit_short` or
  `month_limit`, with the figures), and the page says so under the button and starts no further claim. With accounts
  on, a determination must name a run of the requester's (400 `run_required`), so no test is free by leaving the run
  out. The same claim coming back on another instance after a deploy is a new attempt, held again, and only the newest
  attempt can be charged, so the reader pays once; a claim already delivered and asked for again runs once more, free,
  and then answers 409. That free go is for the same claim only: the row keeps a fingerprint of the claim (its SHA-256,
  never its text), so a different claim under a delivered one's id is refused (409 `already_tested`). At boot every hold left unsettled is settled by its row. Records that cannot be written are a
  wait (503 `books_wait`, which the page rides out), never a free test.
- **The Account page** (/account, four languages): the balance and its history, Add credit (it opens with payments), a
  monthly limit of the reader's own (this month's spend and the day it resets, the 1st, UTC), the activity (each test
  with its date, claim number, verdict and amount; a free one reads Free, one that failed Not charged), a password
  change, sign out everywhere, and deleting the account. It also takes the reset link (`#reset=`) and the operator's
  link (`#claim=`); the token after `#` never reaches a server or its log.
- **A forgotten password:** the reader writes to support from the account's address; the operator makes a one-time link
  on /check (it lasts `CIVIC_RESET_LINK_HOURS`, 24) and sends it. When email sending arrives with the domain, the link
  is sent by itself.
- **The operator's table on /check:** every account with its balance, this month, its tests and its state; add credit
  (an adjustment, with a note), a reset link (shown once, with Copy), close and open, delete (the email and the password
  wiped and the sessions ended; the amounts stay for the accounts). A line under the measurement adds up the credit
  given and spent, and that nothing is collected while payments are not live.
- **Payments**, the last step: Stripe's hosted Checkout for Add credit (its webhook writing a `purchase` row),
  auto-reload, and Stripe's Customer Portal. Nothing of it is built; it needs the Stripe account, which needs the domain.

The access codes of 17 September, their allowance of runs, the sign-in log and the cookie's secret are gone. Their
settings (`CIVIC_ACCESS_CODES`, `CIVIC_OPERATOR_CODES`, `CIVIC_CODE_USES`, `CIVIC_USES_FILE`, `CIVIC_SIGNIN_LOG`,
`CIVIC_SESSION_SECRET`) are read by nothing; the startup line and /check name any still set, for the operator to
delete in Render when convenient.

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
The refusal's sentence says it is FactEngine's server the site turned away, "though people can often read it
in a browser" (the operator's question of 1 October: a reader who could open the article read the old
sentence as saying they could not).

**A link FactEngine cannot read, read through the search service's reader.** The operator's question of 19
October: "Do you try to read pages in 'Reader' mode instead of the full browser page first? I have found that more
successful", and then: "If the server-side or service used can be set to 'reader' on failure and it works, that's
what I care about", on one condition: "keep the current fallback as the third fallback". A link is read in this
order (`/api/read-url`, `server/index.js`):

1. FactEngine's own reader, as above.
2. When that fails on a public web page, the search service's reader is asked for the same address
   (`readerCopy`, `server/copies.js`; Exa's `/contents`, `{urls: [address], text: true}`, which serves its stored
   copy of the page or fetches it itself). That covers a refusal, silence, a page its scripts build, an address that
   cannot be reached, too many redirects, any other status (404, 451, 5xx) and a page with almost no text. Never
   asked: a paywall (FactEngine does not get round one), an address that is not a public web page (never fetched,
   never handed to anyone), a file too large or not text, and a YouTube link (its transcript has its own doors).
   The address asked is the one the failure was about, after redirects. When its text has a paragraph of prose (200
   characters, FactEngine's own rule for a page), it is the answer, exactly as a page read by FactEngine: the box
   fills and the run starts, with the service's title, author and date and `via: 'search'`, so the source's
   attribution says it was read "through a search service's copy of that address". When that text carries the wall
   phrases FactEngine reads, it goes into the box marked and waits for the reader's button, as a marked page does.
3. Otherwise FactEngine's own failure is answered as before, so the page goes on to the copies below, or the sentence
   to paste: the third fallback, unchanged. The service's own reason (Exa: `CRAWL_HTTP_401` when the site turns its
   crawler away too) is a note on /check, `reader_failed`.

The reader is on when the search service is set: its address is `CIVIC_READER_URL`, else the search's own address with
`/search` made `/contents` (Exa's pair); `off` turns it off. It shares the search's key, in the same header and nowhere
else. A rate limit is a wait, as for the search. The service fetches the page itself when it holds no copy, which can
take longer than a site's ten seconds of silence, so its answer is waited for on the connection with no time limit of
its own (as Gemini's); the reader leaving the page is what stops it. Each ask is one ledger line (kind `search`, step `reader`): whether a
page came, where the service's text came from (`cached` or `crawled`), its length, the time and the service's own cost
figure (Exa: $1 for a thousand pages); never the text. The boot line `[read]` names the reader's address, never its
key, and /check's row for a refused link names it too. Tested on 19 October: Exa's reader returned the operator's
ms.now article whole, with its title, author and date, where FactEngine's server had been refused in 0.3 seconds;
Reuters turns Exa's crawler away too (`CRAWL_HTTP_401`), so a Reuters link still goes on to its copies, where Exa's
search found Investing.com's full Reuters text.

**A refused article, found elsewhere.** The same article is often published at another address: papers
that republish another paper's articles with permission end each one with "This article originally
appeared in …", and other outlets report the same story. When a site turns FactEngine away (a refusal,
silence, a paywall or a shell) and the operator has set a search service (`CIVIC_SEARCH_URL` and
`CIVIC_SEARCH_KEY`; `server/copies.js`), the server asks it twice, at once, with only what the link
itself carries: the words of its address (the segment with the most words; ids and section names carry
none) and the date in it, plus the paper's name. One search adds the line republishers print, the
other asks for reports; the refused site is left out of both. What comes back is listed under the box
with each page's headline, site and date: pages that say they are the paper's own article first, then
the reports, each group in the service's order; a page dated more than two days from the link's date
(time zones, and next-day editions), the refused site's own pages and repeats are left out. Nothing decides which page is the article: a paper
often runs more than one article on the same event the same day, so the reader picks by the headline,
and "Test this one" reads that page through FactEngine's own reader and starts the run on it. When the
copy's site turns FactEngine away too, the search service's text of that page goes into the box instead,
with a sentence naming the site and the text's length, and waits: a search's text can be a fragment
(seen live on 1 October: 845 characters of a Washington Post article), so, as with a marked article,
the reader presses the button if it is the whole article, or chooses another from the list, which
stays. The source's attribution in the prompt's slot then says the text was read "through a search
service's copy of that address". While the search runs, the seconds tick under the box; the refusal's pop-up waits, and
appears only if nothing is found. Proved on the operator's Times link of 1 October: a search built from
its words, its date and the republishers' line found The Straits Times' republication first, and
FactEngine's server read it in half a second. The request is the shape of Exa's `/search` (the service
tested), its key travels in `x-api-key` like the transcript service's, each search's cost is the
service's own figure on the ledger (Exa: $7 for a thousand searches), a rate limit is a wait of the
time the service asks, and any other refusal is a note on /check, the key struck out. With nothing
set, nothing is asked and the sentence stands alone.

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
captions to FactEngine's server without a sign-in, as it does for some videos. Open the video on YouTube,
choose Show transcript under the description, copy the text and paste it here.", with each door's
answer on /check; a video with no captions at an open door says so.

When every door is shut and the operator has set a hosted transcript service (`CIVIC_TRANSCRIPT_URL`
and `CIVIC_TRANSCRIPT_KEY`, with `CIVIC_TRANSCRIPT_HEADER` and `CIVIC_TRANSCRIPT_PREFIX` for how the
key is carried and `CIVIC_TRANSCRIPT_JOB_URL` for where a job's result is read), FactEngine asks it as the
last door. No vendor is named in the code: the address takes `{id}` and `{url}`, the answer is read
for whichever shape it has, a single piece of text or a list of pieces, and a service that hands back
a job while it makes the transcript is followed to the end of that job, with no time limit of FactEngine's
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

Addresses that resolve inside a private network are refused, so a public FactEngine server cannot be
aimed at machines behind its own firewall. `CIVIC_ALLOW_PRIVATE_URLS=true` lifts that for local
development only.

## Sources as tools

The model can reach for FactEngine's own tools while it works, through the gateway at `/mcp` (the open
standard, MCP, over HTTP). The gateway is FactEngine's server itself; a provider's servers call it during a
response, with a pass FactEngine issues, and the model's call is answered at once. OpenAI's requests name it
with one entry in the existing `tools` list beside web search when `CIVIC_TOOLS_URL` and `CIVIC_TOOLS_PASS` are
both set (neither is on the service), and nothing else changes: the prompts go byte for byte, and whether the
model calls a tool is the model's decision. A listing on Fireworks names it always, as its only tool, since
Fireworks has no web search of its own: at `CIVIC_TOOLS_URL`, or else at the service's own address, which
Render sets on every web service as `RENDER_EXTERNAL_URL`, followed by `/mcp`. Fireworks' servers forward no
header of the entry's (its first live listing, 5 October: ten calls without the pass, each refused), so each
listing's request names a door of its own in the address, `/mcp/t/<door>` (`server/tools/doors.js`): 24 random
bytes, open from the moment the request is made until its reply ends, then shut, so the address answers no one
again. No pass goes to Fireworks, and nothing new is pasted. At `/mcp` itself the gateway answers OpenAI's pass and
no other; neither the pass nor a door appears in any record, page or line of output.

The tools are **verbs**, few and stable (`server/tools/verbs.js`): `read_page`, `get_transcript` and
`search_web` today; `search_law`, `get_case`, `search_filings`, `get_financials`,
`search_news` as those domains arrive. The **sources** behind them are adapters
(`server/tools/adapters/`, one file each, with a stand-in beside it for the guard): the web, read by
FactEngine's own link reader with all of its rules, is the first; the web's search service (the one that finds
a refused article elsewhere, on when `CIVIC_SEARCH_URL` and `CIVIC_SEARCH_KEY` are set) answers `search_web` in
the model's own words, each call priced at the service's own figure for it; a legal or financial database is one
more file, its key and its address as settings, and nothing else in the program names it. A source
is on when its settings are set; a verb is listed when a source answers it; a verb several sources
answer gains a `source` parameter the model must fill, listing each source in its own words, so the
model chooses the source and FactEngine's code never does. Every source answers in one shape (title,
site, address, date, the text, and where it came from), whole, with the source's own next page as
a cursor when it has one. What a source keeps back (a refusal, a paywall, a silence) reaches the
model as the reader's own sentence, information for its analysis, never as the claim's failure.
Each call is one line in the ledger, priced at the operator's figure for that source, and the row
on the page shows it in the trail like a search. The words the model reads for every verb and
source are printed by `npm run tools`; they are the operator's text, like the prompts.

## What is sent, exactly

Every request to OpenAI carries the operator's tested configuration and nothing else. There is no
number in this program in the path of a determination that the operator did not set.

**The listing on DeepSeek** (`CIVIC_EXTRACT_PROVIDER=deepseek`; the operator's choice of 4 October, "I want use
DeepSeek flash for the generating of empirical claims. It is 10 times faster and better."): the extraction goes to
DeepSeek's `deepseek-flash` through DeepSeek's own Responses API (`https://api.deepseek.com`, `POST /responses`),
with DeepSeek's key (`DEEPSEEK_API_KEY`) and carries `model`, `input` (or `instructions` and `input`, as below),
`reasoning.effort` (`CIVIC_EXTRACT_EFFORT`, never inherited from `CIVIC_EFFORT`: `high` unless set, the operator's answer of
5 October; `low` on the service since 18 October, their answer after an article took five minutes at `high`, "DeepSeek
thinks at low") and `stream`: nothing else. DeepSeek has no reasoning mode, makes no summary and keeps nothing, so no `reasoning.mode`,
`reasoning.summary` or `store` goes. DeepSeek's Responses API ignores `web_search` and every other built-in tool,
silently (its own guide, read 14 October; the listing sent `web_search` from 5 to 14 October and never searched), so
no `tools` goes: the listing reads the document it is given. DeepSeek streams its whole chain of thought instead of a
summary: it is neither sent to the page nor kept anywhere, because it restates the prompt's instructions in the
model's words (the operator's answer of 4 October). The client is built only with DeepSeek's own key and takes none
of OpenAI's settings from the environment (key, organisation, project, admin key, custom headers). DeepSeek sends no
per-minute figures, so the listing on DeepSeek does not go through the gate; its limit is 2,500 requests in flight
per account, and its 429 names no wait, so the listing goes again a second after the refused go began, as long as it
takes. A 503 and an error in the middle of a stream are retried the same way; a stream that ends without its last
event (DeepSeek closes a request not started within ten minutes) is a cut connection and goes again, never a listing
of no claims. A key DeepSeek rejects (401) or a balance used up (402) is shown to the reader as FactEngine's own
sentence, and DeepSeek's words go to the record on /check, which also reads DeepSeek's key, model and balance (`GET
/models`, `GET /user/balance`, no tokens; the figures to the operator alone). The readers' determinations stay on
OpenAI as below. `CIVIC_EXTRACT_PROVIDER=openai` (or unset) puts the listing back on OpenAI exactly as before.

**The operator's trial on DeepSeek and Gemini** (14 October: "I think the best experiment is to use the new DeepSeek deep
reasoning model through the already connected API"; 18 October: "There is only 1 DeepSeek model for fact checking", and
"I want to test the new Gemini model using argon medium and argon high"). On the operator's page alone, above "Test N
selected claims", the operator chooses what determines the claims in one pull-down: the readers' model; DeepSeek V4 Pro
(`deepseek-v4-pro`, the deep-reasoning one) at one of DeepSeek's efforts beside it (`none`, `low`, `high`, `max`; the page
opens on `high`, the level DeepSeek gives `xhigh`); or "Gemini 4 Argon · medium" or "Gemini 4 Argon · high", each level
its own entry. And whether each claim also runs on the readers' model, side by side (its card right under the trial's,
labelled, not counted on the scoreboard). The choice is remembered in that browser; an entry that cannot run here is
shown and cannot be chosen, its reason said beneath. The server takes a model and an effort from the operator's session
only; from anyone else they are ignored and the request is the readers' own. The models are `CIVIC_EVAL_TRIAL_MODELS`
(`deepseek-v4-pro,gemini-4-argon` unless set; `off` ends the trial). V4.1 Flash lists and ranks the claims and is not a
fact-checker.

On Gemini (`server/gemini.js`) a fact-check is one request to Google's Interactions API, with the operator's own key
(`GEMINI_API_KEY`, sent in `x-goog-api-key` and nowhere else): `model`, `input` (the two messages a reader's
determination carries, as `user_input` steps), `generation_config` (`thinking_level` medium or high, the operator's
two levels and no other, and `thinking_summaries: auto`), `tools` (Google Search and URL context, so the model searches
Google and reads pages itself inside that one request), `stream`, and `store: false` (without it Google keeps each
interaction for 55 days): nothing else. Its searches and the pages it read are the card's trail, its citations the
card's sources, and Gemini's own summary of its thinking is shown as the readers' model's is; its thought signature is
neither sent nor kept. A 429 waits for the wait Google names (or a second when it names none, never none at all), and
the card says so in its own words: "Google asks to wait · 56 min 06 s · until 7:00 PM", counting down, with Google's
reason on a line under the bar, the key taken out (the operator's answer of 18 October, after a first question was
made to wait 56 minutes in silence: "Say why and keep waiting"); the reason is kept on /check (`rate_limited`) and in
the service's log, once for each new wording. A 429 whose words give a limit of 0 ("limit: 0 input tokens per minute on
Free Tier": the project behind the key is on a tier without the model) is no wait, since none can let it through: the
fact-check ends at once, its card reading "This claim could not be tested. Google: …" in Google's sentence (the
operator's answer of 19 October: "Stop and say why"), with `tier_refused` and Google's words on /check. A refusal Google
sends in the stream's own form (`event: error`, then `data: {…}`) is read for its JSON, so the card carries Google's
sentence alone. A 5xx and an error mid-stream go again, a stream that stops early goes again; a refused key (401, 403) and the prepaid balance used up (402) end the fact-check at
once, with Google's words on /check. Its cost is Google's tokens (thinking included as output, the pages read as input)
at the day's price, plus $14 per 1,000 Google searches: an upper bound while the month's 5,000 free searches last.
Google sends its search suggestions with each grounded answer and its terms set how search-grounded answers are shown to
people; the trial shows its answers to the operator alone and does not draw the suggestions, so those terms are to be
read and met before Gemini ever serves readers.

On DeepSeek: since DeepSeek does not search, a trial fact-check offers the model FactEngine's own tools as
functions (`search_web` through the search service, `read_page` and `get_transcript` through FactEngine's reader, in the
words of `server/tools/verbs.js`), and FactEngine runs each call the model makes, round after round, until it writes
its entry; without the search service (`CIVIC_SEARCH_URL`, `CIVIC_SEARCH_KEY`) the trial is shown as unavailable and
nothing is sent. Each round carries `model`, `input` (the two messages a reader's determination carries, then each
round's reasoning and calls and the calls' answers), `reasoning.effort`, `tools` (the functions) and `stream`: nothing
else. DeepSeek requires a model using tools to be sent back its reasoning of the earlier rounds, so it is held in memory
for that one fact-check; it never reaches the page, `done`, the ledger or a failure record. A round waits and goes again
as the listing does (a 429, a 503, an error mid-stream, a stream that stops early). A trial fact-check is a row of kind
`trial`: never charged, never one of the document's free ones, never in the readers' measurements, and summed on /check
per model and effort (delivered and failed, minutes, searches and pages read, cost each and in all, verdicts, unread
verdicts), beside the readers' model. Its cost is DeepSeek's tokens over its rounds, each at the hour's price, plus each
search's own cost. Readers' texts (Privacy, Terms) are unchanged: their fact-checks stay on OpenAI.

**The second pass: the claims a document rests on** (16 October). The operator: "We have way too many claims from a
single article", and "I only want the top 25% of the most important claims, or 1/4, presented for testing. The rest are
useless or not load-bearing and make the person pay to learn the obvious." After the listing, inside the same job and
before the page is told the listing is done, the listing's own DeepSeek model reads the document and the claims it
listed, under the operator's ranking prompt (the vault's third, `rank`: `server/prompts/rank.txt`, or Render's secret
file `rank.txt` through `CIVIC_PROMPT_RANK_FILE`). The request carries `model` (the model the listing used), `input`
(two messages: the source exactly as a determination is given it, then the prompt verbatim with `{{TITLE}}` filled with
the page's own title, or "(none given)", and `{{CLAIMS}}` with each claim's number and whole entry), `reasoning.effort`
(the listing's, unless `CIVIC_RANK_EFFORT`: `low` on the service since 19 October, the operator's answer after the
ranking took 69 s at `high`, 68 of them thinking, beside the listing's 55 s at `low`) and `stream`: nothing else. No tools (it reads what it is given) and no
store. The answer is read by its headings, SUMMARY, HEADLINE, HEADLINE TYPE, HEADLINE CLAIM, RANKED and NOT EMPIRICAL,
which a prompt the operator edits keeps. The page then shows:
- the summary, as it is written, in a window beside the picture that scrolls inside itself (under the steps on a phone);
- the headline first, tagged, when the model calls it an empirical statement and copied it word for word from the page's
  title or the document (FactEngine never tests words of the model's own), so it is the first fact tested;
- then the top quarter of the ranked claims (`CIVIC_RANK_KEEP_PERCENT`, 25, rounded up: the operator's answers), and
  the rest, in their order, behind "Show the other N claims";
- how many statements were set aside as not empirical.

A listed claim that says what the headline says is not shown twice; one the model left out of its lists is kept at the
end. A ranking that fails or cannot be read leaves the list whole, as before the second pass, and is recorded on /check.
A wait is a wait, as for the listing, and a connection cut while the claims are ranked costs nothing (the page comes
back to the same job). DeepSeek's chain of thought is neither sent nor kept. The ranking's ledger line is its own (kind
`rank`), its cost joins the run's listing cost, and /check times it apart. `CIVIC_RANK` says whose runs are ranked:
`operator` (unset; the operator's runs alone, their choice of 16 October), `on` (everyone's) or `off`. It runs on
DeepSeek only: with the listing elsewhere, or no ranking prompt installed, the claims are listed unranked.

**Fireworks is never used again** (the operator, 5 October: "Never go back to fireworks. That's like killing users by
making them watch paint dry for 48 hours."). Its code stays, inert, and is described below for the record; the
listing's fallback is `CIVIC_EXTRACT_PROVIDER=openai`.

**The listing on Fireworks** (`CIVIC_EXTRACT_PROVIDER=fireworks`; the operator's choice of 5 October, "Maybe
someone in the US is hosting the model so we can avoid the China issue"): the same model, DeepSeek V4.1 Flash
(`accounts/fireworks/models/deepseek-v4p1-flash`), served by Fireworks, a US company, through its Responses API
(`https://api.fireworks.ai/inference/v1`, `POST /responses`) with Fireworks' key (`FIREWORKS_API_KEY`). DeepSeek the
company receives nothing. The request carries `model`, `input` (or `instructions` and `input`), `reasoning.effort`
(`high`, the operator's answer of 5 October after a small article took over seven minutes at `max`; `CIVIC_EXTRACT_EFFORT`, never inherited from `CIVIC_EFFORT`), `tools`
(one `mcp` entry naming FactEngine's tool server, as above: Fireworks has no web search of its own and calls the
tool server itself, so the model searches, reads a page or a transcript through FactEngine), `stream` and `store:
false`, without which Fireworks keeps the conversation 30 days; with it, nothing is kept, and Fireworks trains on
nothing. Fireworks serves this model from its own data centers in the United States, Germany, Iceland and Japan
(its US-only service covers other models). The model's chain of thought arrives inside the answer's own text, ahead
of `</think>` (Fireworks' own examples read the answer after it): FactEngine holds each answer's text until the
marker, drops everything before it, and passes only what follows, so the reasoning never becomes a claim and never
reaches the page, the job's replay, the raw listing, the ledger or a failure record; text with no marker is the
answer whole, and reasoning sent apart is dropped as DeepSeek's is. Fireworks counts tokens as `prompt_tokens` and
`completion_tokens`, read into the price table's shape; the ledger line keeps Fireworks' own echo of the effort it was
asked for, and /check shows it (Fireworks documents no effort key of its own, so its echo is the proof that `max`
reaches the model). The client takes none of OpenAI's settings; the listing does not go through OpenAI's gate; a 429 is a wait
(Fireworks' retry-after, else a second), a 5xx and an error mid-stream are retried, an early end goes again. A key
Fireworks rejects (401) or an account that cannot pay (402) is FactEngine's own sentence on the page, Fireworks' words
on /check, which also reads the key and the model (`GET /models`, no tokens) and whether the tool server answers at its
public address.

**Extraction request:** `model`, `input` (the extraction prompt, verbatim, with the source in
place of its final bracketed line, as the only message), `reasoning.effort`, `reasoning.mode`, `reasoning.summary`,
`tools` (one `web_search`, no options; and, when the gateway is set, one `mcp` entry naming it, with `server_label`, `server_url`, `headers` carrying the pass and `require_approval: never`, nothing else), `stream`, `store`. The source goes into that slot with
what FactEngine knows of its attribution, since the slot asks for it: for a link, the page's title,
author, site, date and address and the day FactEngine read it; for a file, its name and the day; for
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
| The listing's provider | `CIVIC_EXTRACT_PROVIDER`: `openai` (unset), `deepseek` (DeepSeek's own service: `deepseek-flash` on `DEEPSEEK_API_KEY`) or `fireworks` (the same model from the US: `accounts/fireworks/models/deepseek-v4p1-flash` on `FIREWORKS_API_KEY`, searching through FactEngine's tool server, `store: false`). Either runs at effort `high` unless `CIVIC_EXTRACT_EFFORT` says otherwise (the operator's answer of 5 October, `max` before); the service runs it at `low` since 18 October ("DeepSeek thinks at low", after an article took five minutes at `high`); `CIVIC_EXTRACT_MODELS` changes the model. The keys are pasted by the operator in Render; a key is read under its name whatever its capitals (`DEEPSEEK_API_Key` is `DEEPSEEK_API_KEY`), the exact name winning, and two spellings holding different keys are used neither, /check naming both. `CIVIC_DEEPSEEK_BASE_URL` and `CIVIC_FIREWORKS_BASE_URL` are the providers' addresses (only the guard changes them). The readers' determinations stay on OpenAI. | Operator, 4 and 5 October |
| The second pass | `CIVIC_RANK`: `operator` (unset: the operator's runs are ranked), `on` (everyone's) or `off`; `CIVIC_RANK_KEEP_PERCENT` (25: the part of the ranked claims shown, rounded up, behind an empirical headline); `CIVIC_RANK_EFFORT` (the listing's unless set; `low` on the service since 19 October, after the ranking took 69 s at `high`, `high` from 18 October); the ranking prompt, `rank` (optional; `CIVIC_PROMPT_RANK_FILE`). On the listing's DeepSeek model. See "The second pass" above. | Operator, 16 October |
| The operator's trial | `CIVIC_EVAL_TRIAL_MODELS`: the models the operator may choose on the page for their own determinations (`deepseek-v4-pro,gemini-4-argon` unless set; `off` ends it). DeepSeek V4 Pro needs `DEEPSEEK_API_KEY` and the search service; Gemini 4 Argon, at medium or high, needs `GEMINI_API_KEY` (the operator's own Google key, pasted in Render; `CIVIC_GEMINI_BASE_URL` only the guard changes). Each runs or not on its own. Never charged, never in the readers' figures. | Operator, 14 and 18 October |
| Reasoning effort, both steps on OpenAI | `xhigh` | Operator, 5 October: back to the setting before 21 September, when `max` in `pro` mode had taken a listing to fifteen minutes and $3.81 and a determination to almost seven minutes and $3.71. `max` from 21 September to 5 October. |
| Reasoning mode, both steps on OpenAI | `standard` (no mode key sent) | Operator, 5 October, as above. `pro` (GPT-5.6's pro mode, OpenAI's "highest-intelligence API option": more model work per answer at the same per-token rates) from 21 September to 5 October; `CIVIC_REASONING_MODE=pro` brings it back. |
| Web search | on, both steps, not configurable | The prompts were tested in a UI where search is available to every prompt. A request without it is not what was tested. |
| Reasoning summary | `auto` | Display only: the model's own account of its reasoning, shown on the card. Does not change the answer. Blank to turn off. |
| Claims run automatically | `CIVIC_AUTO_TEST_FIRST` of them (10 unless set; 0 = none: every claim found waits for the reader's checkbox and runs when chosen), ten at a time (`CIVIC_EVAL_CONCURRENCY`, the operator's figure of 3 October on a minute budget of 40,000,000 tokens), each on its own request, the whole selection in one batch. The page is told both figures by the server (`autoTestFirst` and `inFlight` on `/api/health`), so what runs and how fast change with one setting and no release. The intake sentences follow the figures too. | Operator's rule; 0 since 1 October |
| Prices and tiers | Listing free; a determination at one list price for everyone, `CIVIC_LIST_PRICE_CENTS` (125: "each fact-check is $1.25"; unset, nothing priced), said once above the claims and on no row or button; a run's tier (1: nothing free; 2, 3: one, two of the reader's choices free per document) rotating every six hours in `CIVIC_TIER_ORDER` (1,2,3) with a daily shift; a loss guard to tier 1 when a window loses more than `CIVIC_TIER_LOSS_GUARD_USD`; revenue at list, not collected; every user measured in Postgres, and /check's figure of how many fact-checks the key runs at once. See "Facts have a price". | Operator's program, 2 October; the list price and 0, 1 or 2 free, 6 October; every figure theirs |
| Accounts and credit | On unless `CIVIC_ACCOUNTS=off`: an account by email and password before anything runs; the operator's account only through the one-time link (`CIVIC_OPERATOR_CLAIM`, its SHA-256; `CIVIC_OPERATOR_EMAILS`, the reserved address); `CIVIC_SIGNUP_GRANT_CENTS` (1000) of credit to start; a test's price held when it starts, charged when it is delivered, released when it is not; a monthly limit of the reader's own. Flagged defaults, the operator's to change: `CIVIC_PASSWORD_MIN_CHARS` 8, `CIVIC_SESSION_DAYS` 400, `CIVIC_SIGNIN_TRIES` 10 an hour, `CIVIC_RESET_LINK_HOURS` 24; off unless set: `CIVIC_SIGNIN_TRIES_PER_ADDRESS`, `CIVIC_SIGNUPS_PER_ADDRESS_PER_DAY`. See "Accounts and credit". | Operator, 5 October |
| Pacing | OpenAI keeps a bucket of the key's minute limit that refills continuously at that limit per minute; each request costs what OpenAI estimates for it, and a request the bucket cannot hold is refused with exactly the wait that refills the difference (its refusals say so, to the millisecond). FactEngine reads those figures from every reply and every refusal. A request goes when the bucket, less what is reserved by the sends whose headers have not yet arrived (each at what OpenAI has shown for its kind), holds its cost; when the headers arrive their figure replaces the reservation. So many readers' requests leave together, bounded by the bucket, instead of one after another. The first request ever, and the first of each kind of request (a listing, a determination), goes alone into a full minute so its reply shows its cost exactly; a refusal's Requested figure is learned too, so a larger cost is met once and never twice. The line is an order, not a figure: listings before determinations (listing is the free first step), and among determinations the readers take turns, so one reader's thirty queued claims never starve another's first three; a request OpenAI turns back waits exactly what OpenAI asked and goes again first. The check page's pacing row shows the key's figures, what is in the air with its reservations, what waits by kind and by reader, and the refusals. | Built from OpenAI's refusals of 16 September; parallel sends, the order and the turns on 3 October |
| Rate limits | Never a failure, never an error on a row. A refusal at the door sets the bucket to OpenAI's figures; the refused request waits exactly what OpenAI asked and goes first. A refusal can also arrive inside a running reply, when the response's own later call (after a web search) finds the minute short and OpenAI ends the response with its figures in an error event: it is read the same way, the claim waits exactly what OpenAI asked, and goes again whole. This is why the pace per reader is a figure rather than everything at once: a running reply is charged again at each of its later calls (67,000 to 89,000 each in September's readings), by far more than its admission showed, and the gate cannot see those charges, so many parallel claims can starve one another; the limits are per organization and model, so every reader shares the key's minute. The key's minute read 500,000 tokens on 16 September, 2,000,000 on 18 September and 40,000,000 on 3 October (the check page's pacing row is the authoritative reading), so the pace went one, two, three, four, three, and ten on 3 October on the operator's word; a larger budget still is OpenAI's to grant on request. The figure is a setting, so it moves without a release. A used-up quota is reported in words. | OpenAI's own numbers |
| Retries | None counted on a connection that could not be made or was cut: that is the operating system's report ("no route to host", "connection refused", "connection reset"), never OpenAI's, and nothing was decided by it. The claim waits for the connection and goes again a second after the failed go began, however long the route is missing; a go that finds no route costs nothing. The row says why it waits, in the system's words, and /check records the outage with its start, its cause, its length and the machine's addresses at the time. 8 on a 5xx, which costs nothing. No back-off of ours: a failed attempt rejoins the line at the gate, and OpenAI's own retry-after, when given, comes first. | Never on a model or parameter error |
| Time limits | None of ours, on either step or on reading a link. An extraction of a very long document or a determination at a high effort takes as long as it takes; a connection the network reports dead is made again, not counted as a failure. | Operator's rule |

Environment variables: `CIVIC_MODEL`, `CIVIC_EFFORT` (both steps), or per step
`CIVIC_EXTRACT_MODELS`, `CIVIC_EXTRACT_EFFORT`, `CIVIC_EVAL_MODELS`, `CIVIC_EVAL_EFFORT`,
`CIVIC_EXTRACT_REASONING_SUMMARY`, `CIVIC_EVAL_REASONING_SUMMARY`; for the listing's provider,
`CIVIC_EXTRACT_PROVIDER`, `DEEPSEEK_API_KEY`, `CIVIC_DEEPSEEK_BASE_URL`, `FIREWORKS_API_KEY` and
`CIVIC_FIREWORKS_BASE_URL`; for the second pass, `CIVIC_RANK`, `CIVIC_RANK_KEEP_PERCENT` and `CIVIC_RANK_EFFORT`; for the
operator's trial, `CIVIC_EVAL_TRIAL_MODELS`, `GEMINI_API_KEY` and `CIVIC_GEMINI_BASE_URL`. There is no setting that removes
web search.
The server prints the exact shape of both requests at startup.

The image is a picture, not a determination, and the operator asked for the fast model there
(`CIVIC_IMAGE_*`).

### When something goes wrong

```
http://localhost:3000/check
```

With accounts on, open it signed in as the operator; anyone else is told it is not found. With `CIVIC_ACCOUNTS=off`
it is everyone's, as is the rest of the page. It asks the server what is wrong and answers in sentences: whether both prompts are installed, whether
a key is configured, whether OpenAI accepts that key, and whether the key may use the configured
model. The model check reads the model's description rather than running it, so it spends nothing.
Each failure carries the step that fixes it, and the page lists recent failures from both the server
and the browser, so a message that has already disappeared can still be read. Nothing secret is
recorded: keys are redacted and no prompt or document text is kept.

A failure during a run also stays on the page until the next run, rather than appearing briefly in
a message that vanishes.

A determination's reply that stops before its last event (completed, incomplete or failed) was cut, however politely:
the claim goes again, as for a cut connection, and is never delivered or charged as an entry. An error event in the
middle of a reply (a rate limit, an overloaded server) is read for what it is, a wait or a retry, never a failed claim.
A claim taken up again starts its card afresh (its searches and sources are the delivered go's), while its cost counts
every search OpenAI ran. And a claim's end is booked before the page hears of it, so a request the page makes on
hearing of it (the same claim asked for again) finds it booked, never still running (fixed 14 October).

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
  The verdict is read afterwards from the model's own Conclusion section. The ranking prompt (the second pass) gets
  its two slots filled, `{{TITLE}}` and `{{CLAIMS}}`, and nothing else; the leak check covers it as it covers the others.

When accounts arrive, the prompts should move to a secrets manager rather than files on disk.

**What a reader receives** (`server/view.js`, 19 October). The operator, and anyone on an open door, receive every
event of a run as it is made. Anyone else receives every output of their run, under the operator's names, through one
view applied where the job records each event, so a page that reconnects or reads a finished run again receives the
same: the entry, the verdict, the confidence, the sources cited, the reasoning summary, the research log with each
step's question and address, the listing as written, and a work log counted in plain words ("4 searches · 2 pages read
· 2 sources cited"). `/api/health` tells anyone but the operator only what the page needs. The names, and the headings
an entry is read by, are kept with the prompts (`CIVIC_OUTPUT_NAMES`, or `CIVIC_OUTPUT_NAMES_FILE`;
`server/names.js`), FactEngine's own words unless set; a list that cannot be read stops the start, naming the key and
never a word of it, and `/check` names the list by its fingerprint. The leak check reports what it finds by
fingerprint, never by its text.

**What anyone can download** (`server/assets.js`, 20 October). Every script, style sheet and page of FactEngine's own
is sent without its comments, every other character as written (a licence notice stays); each is read at start-up, and
one that cannot be read stops the start, naming it. The page comes in two forms: the operator's, and everyone else's
without the operator's parts (the cost, the key's minute, the trial bar), which sit between `op` marks in
`public/index.html`; their words are in those parts, not in the four locales. A sign-in or sign-out that changes the
form loads the page again once nothing is running. `/check` and its script are the operator's, however the address is
spelt. Of the vendor packages, only the files the pages load are sent, as shipped; their source maps are not.

## Models

| Step | Default | Why |
|---|---|---|
| Extraction | `gpt-5.6-sol`, effort `xhigh`, standard mode, web search on; with `CIVIC_EXTRACT_PROVIDER=deepseek`, DeepSeek's `deepseek-flash`, effort `high`, no search (DeepSeek ignores it); with `CIVIC_EXTRACT_PROVIDER=fireworks`, the same model on Fireworks, effort `high`, FactEngine's tool server for its searches | The operator's configuration; DeepSeek flash on the operator's word of 4 October ("10 times faster and better"), served from the US by Fireworks on their word of 5 October, and back on DeepSeek's own service the same day for speed (never Fireworks again). Fireworks' price per million tokens (its serverless price from 1 October 2026, per its release note): input $0.30, cached input $0.006, output $1.20, at every hour. DeepSeek's price per million tokens (its page, 4 October): input $0.30, cached input $0.006, output $1.20 at peak hours (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday), half at every other hour; FactEngine prices each listing at the hour it went. A `CIVIC_PRICING_JSON` override of a DeepSeek row replaces the whole row, so it repeats `offPeak` and `peakUtc`. |
| Determination | `gpt-5.6-sol`, effort `xhigh`, standard mode, web search on | As requested (5 October: back to the setting before 21 September). Web search lets the inspector reach primary sources, and every query and citation is shown. |
| The operator's trial | `deepseek-v4-pro`, at the effort chosen on the page (opening on `high`), FactEngine's own tools for its searches and pages; or `gemini-4-argon` at `medium` or `high`, Google's own search and page reading, `store: false` | The operator's words of 14 and 18 October: their own runs alone, beside the readers' model. DeepSeek's price per million tokens (its page): V4 Pro $1.32 in, $0.044 cached, $3.96 out at peak hours, half otherwise. Google's (its page of 16 October): Argon $2 in, $0.10 cached, $10 out (thinking included) through 30 November 2026, then $4, $0.20 and $20; Google Search $14 per 1,000 searches after 5,000 free a month. |
| Art direction | `gpt-5.6-luna`, effort `low` | Reads the document and writes a concrete photographic brief for the echo. About two seconds. |
| Visual echo | `gpt-image-2.5-flare`, quality `high` | OpenAI's fastest image model. Quality is `high`, not `low`: the speed comes from the model, not from starving it. |

One model id per step means no fallback. Only if the operator lists several ids in
`CIVIC_EXTRACT_MODELS` or `CIVIC_EVAL_MODELS` does the server move down the list, and only when the
key cannot use the earlier id; when that happens the page shows a warning naming both models.
The scoreboard shows the three counts and, with internal accounting on, the run's estimated cost.
No token figure appears anywhere on the page or in what the page receives (the operator's rule of
18 September); the ledger keeps OpenAI's usage per request.

### Why the echo looks the way it does

The echo is off since 19 October, on the operator's word after its box appeared and vanished with no picture: "Just
comment it out for now until I decide whether and when to ask for it back." Its checkbox (`public/index.html`) and the
call that starts it (`startRun` in `public/js/app.js`) are commented out, and uncommenting both brings it back as it
was. The server's route and the rest of the code are unchanged. The echo's picture comes as a `data:` address, so the
security policy names no image service's host while the echo is off; if it ever comes back by the service's own
address, that host goes back into `img-src`.

An image model handed raw document text returns something generic. Stage one therefore reads the
document and writes a specific brief — subject, setting, foreground, light, palette, lens — and
stage two makes that brief as an edit of the FactEngine photograph (`public/assets/civic-scene-1920.jpg`,
the style reference photograph, formerly the page's background), attached to every request: the model
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
   ever use), `DATABASE_URL` (a Render Postgres's internal address: accounts, sessions, credit and the measurement
   live there), `CIVIC_OPERATOR_EMAILS` (your address) and `CIVIC_OPERATOR_CLAIM` (the SHA-256 of a one-time link's
   token of your own). Save.
4. Deploy. The service gets an address like `https://civic-xxxx.onrender.com`. Open
   `…/account#claim=<the token>&email=<your address>`, choose a password, and your account is the operator's. Then
   paste a document and press Test the facts.

The prompts live only in Render's secret store and the server's memory; they are never in the
repository. The internal ledger is written to a temporary disk and does not persist between deploys;
accounts, sessions, credit and the measurement are in Postgres and do.

Each claim is tested on its own request, so no response outlasts one claim (Render allows a
response 100 minutes). The work itself belongs to the server, not to the connection
(`server/jobs.js`): every extraction and every determination is a job under an id the page made,
and the reply is a stream of the job's events. A connection that is cut on the way (a browser's
network, a relay such as iCloud Private Relay, which cut a finished four-minute extraction on
18 September) stops nothing: the page opens a new connection a second later, says how many events
it already has, and receives the rest; the step line or the row reads "The connection to FactEngine
was cut · going again" meanwhile. A connection can also die without saying so: on 18 October a VPN
changing its exit left the operator's Safari waiting on one for over a minute, still showing "21 claims
found" while the listing finished at the server. So every stream says it is alive every 5 seconds,
and the page counts three silent heartbeats, before the reply or in the middle of it, as a cut, and
goes again in the same way. Nothing is run twice and nothing is paid for twice. Only the
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
