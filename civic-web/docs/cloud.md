<!-- This file exists so that a fresh Claude Code session can continue the move of CIVIC to Render
without the conversation that produced it. Read it whole before doing anything. It holds no
secrets: the Render API key and the OpenAI key are environment variables of the operator's
claude.ai cloud environment (RENDER_API_KEY, OPENAI_API_KEY); the two prompts are never in this
repository and never in chat text, and the operator attaches them as files (extract.txt,
evaluate.txt) when a session needs to upload them to Render as secret files. The operator is a
non-developer: no GitHub mechanics for them, no tasks pushed onto them that can be automated,
nothing of the model's output withheld, no arbitrary limits, prompts sent byte for byte. -->

# Handoff: where the move to Render stands (18 September 2026, 02:30 UTC)

- **CIVIC runs in the cloud.** Service `civic` (id `srv-dam9vlrm8hqs73d28tk0`) in the Render
  workspace `tea-dak7rhnqj5pc73a4dj50`, Starter, Ohio, at `https://civic-c64i.onrender.com`,
  created through Render's API on 18 September at 02:20 UTC with the blueprint's settings, the two
  prompts as secret files, the operator's key and the five access codes as variables. The first
  deploy went live in thirty seconds on main's commit 701825f. Verified from the session: the page
  and /check answer; /api/extract without a cookie is refused (401 signin_required); an unlisted
  code is refused (401 code_not_listed) and sets no cookie; a listed code signs in (cookie HttpOnly,
  SameSite=Lax, Secure, 400 days); /api/selftest signed in reports ready, both prompts (extract
  f798309e, evaluate c52121a0), the key accepted by OpenAI, the ledger writable; build stamp
  318a32fe7492, which is the stamp of main's code (docs are not part of it). The codes were sent to
  the operator as a private file.
- **How it was unblocked.** Render's account deploys as the GitHub user halseyminor500-creator,
  which cannot see the private repository (see Stage 1 below). Rather than re-point Render, the
  operator made the repository public on 18 September at 02:15 UTC; Render's API then created the
  service without any credential. Consequence: the repository must stay public unless Render's
  credential is changed to a GitHub account that can see it privately (the four steps in Stage 1).
- **The first real run on the URL (18 September, 02:29 UTC) found the cloud's own failure.** The
  server finished the extraction (4 min 12 s, 284 KB streamed, status 200) and the operator's
  Safari never received the end of it: the request came through a relay (Cloudflare's proxy
  network, which is how iCloud Private Relay exits), and fourteen minutes later Safari gave up
  with "Load failed", which the page showed as "CIVIC's server is not reachable". Two gaps: a cut
  during extraction was a failure (a cut during a claim was requested again), and the server took
  a closed connection for a reader who had left and threw the finished work away, so any
  re-request paid again. Fixed by making the run the server's (`server/jobs.js`): every
  extraction and determination is a job under an id the page made; a cut connection is opened
  again a second later with the number of events already received and gets the rest; only the
  page's cancel (Start a new test, leaving the page) stops a job; a finished job is kept until the
  page says it has it; `/api/health` `active` counts jobs, not sockets. Proved by the guard (a cut
  three events into an extraction and into a determination, one model call each; cancel aborts;
  release lets go) and in a browser taken offline during both steps.
- **Deploy while idle: proved** (the merge of PR #30 deployed by itself in 24 seconds through the
  app installation on the organisation). **The operator's real run (18 September, 14:16–14:38
  UTC) completed**: the extraction in 4 min 20 s, ten claims two at a time, every result
  delivered, no cut, no failure. **A deploy during a run** was proved on a local copy (the server
  ended with SIGTERM and started again with two claims in flight: both rows said the connection
  was cut and was going again, both claims started over on the new server and finished); the
  session's permission system declined a deploy of the live service for that purpose.
- **18 September, evening: the operator's change set.** The heading is "Truth Engine tests the
  facts."; the page says ten claims everywhere; Download full run is gone; "Test {n} selected
  claims" and the new "Create report" button (beside the bottom "Start a new test", after the
  first ten) are parked and say so when pressed; an open row closes on a tap anywhere in it and
  the next row scrolls into view; each code allows a number of runs (`CIVIC_CODE_USES`, five,
  or `CODE:150` in its own entry), counted at the start of an extraction in `CIVIC_USES_FILE`
  (server/uses.js), refused past the allowance with the figures on the page, listed on /check.
  For the count to outlive a deploy the service needs a 1 GB disk at /var/data, with the ledger,
  the sign-in log, the error log and the uses file on it (render.yaml describes it); a deploy
  with a disk stops the service for about a minute, which the page rides out. The operator's own
  code (the one ending JT, the only such one of the five, named by the 02:27 sign-in line) allows
  150. State on 18 September, 15:55 UTC: PR #32 is live; the variables are set on the service
  (the code list with `:150` on the operator's code, `CIVIC_CODE_USES=5`, the uses file and the
  logs under /tmp until the disk exists), and a variable change through the API starts no deploy,
  so the merge of this note carries them into the running process. The session's permission
  system declined creating the disk through the API; it is the operator's, in Render's dashboard:
  the service → Disks → Add Disk, name civic-data, mount path /var/data, size 1 GB (Render
  deploys on its own). Once it exists, the four file variables move to /var/data through the API
  and the next merge applies them. State on 18 September, 16:20 UTC: PR #33 merged at 16:12 with
  active 0 and Render deployed it by itself (same build, docs only); /api/selftest lists the
  operator's code allowed 150 and the other four 5, with every count at 0 because the uses file
  restarted with the instance (it stays under /tmp until the disk exists). The operator's second
  run on the address (15:51–16:11 UTC: one extraction of 227 s, ten determinations of 152–244 s two
  at a time, every job released, no reconnection, no error) was made on the change set's build.
  The extraction prompt's cutoff (a maximum of forty claims, named in nine places) was put to the
  operator, who first chose to leave it and then (18 September, 16:40 UTC) asked for no cutoff:
  the number is raised, and only the number (40 → 1000 in eight places, "forty" → "one thousand"
  in one), so every empirical claim comes through; the vault copy carries hash fad6cbae (8,331
  characters), the secret file on Render was replaced through the API, and the next deploy loads
  it. Open: the disk, then the file variables.
- **18 September, night: the operator's second list.** The scoreboard's Tested and Tokens items
  are gone (the counts and, with accounting on, the estimated cost remain); the empty caption bar
  that painted a light strip over the bottom of the picture is gone (the Images API returns no
  model name, and the bar showed that empty name); the footer line about a key in the browser is
  gone; the picture is now an edit of the CIVIC photograph (`public/assets/civic-scene-1920.jpg`,
  the style reference photograph, formerly the page's background, the file the operator attached), sent with every request
  as the style reference with the instruction to take only how it is made and none of what it
  shows (server/illustrate.js; the SDK streams the file afresh on every attempt because a
  buffered upload fails with the server's fetch); the ledger records OpenAI's usage for it. The
  pace: the operator asked for four claims at once; the arithmetic (the key's 500,000-a-minute
  limit; each running claim charged 67,000–89,000 at each call after a search; four ≈ 600,000,
  three ≈ 450,000) was put to the operator, who chose three, as a second release after this one
  is live and the check page's pacing row has been read from a run on it.
  Release B (three at once) is the page's `IN_FLIGHT` constant (public/js/app.js), the server's
  `evalConcurrency` default (for a request carrying several claims), the guard's "three at a time,
  never a fourth" check, the lede's sentence in four languages, and these notes.
  Same evening, the operator's rule that no token figure appears anywhere a reader can see: the
  per-card token line is gone, and the extraction and determination events sent to the page no
  longer carry `usage` (the ledger keeps it); the guard checks both.
  And no mention of a key on the consumer page: the tooltip, the waiting lines ("Waiting its
  turn"), the failure sentences (which no longer name the provider or the check page either) and
  the served page's comments; the connection-wait lines drop the provider's name too. Still
  showing the process to a reader, flagged for the operator's word: the per-card model line, "What
  the model says it is doing", the searches count, the Internal cost chip
  (`CIVIC_INTERNAL_ACCOUNTING`), the raw extraction view, the check page for any code holder, the
  served scripts' comments, and the public repository itself.
- **18 September, 22:09 UTC: four at once.** The operator's run of 19:14 UTC on the three-at-once
  build (one extraction, one determination, the picture through the edit route, no wait) put the
  key's current figures on the check page: gpt-5.6-sol 2,000,000 tokens a minute, 5,000 requests a
  minute, refusals 0 (the 500,000 of 16 September was out of date). Four at once ≈ 600,000 in a
  typical minute fits with a wide margin, so the operator's original ask, four, is the pace:
  `IN_FLIGHT` 4, `evalConcurrency` 4, the guard's "four at a time, never a fifth", the lede in four
  languages.
- **18 September, 22:30 UTC: a link that cannot be read.** The operator pasted a Google app link
  (`google.com/goto?url=<token>`) and saw nothing happen: the token is opaque (binary, no address
  inside), only Google can resolve it, and Google gives Render's servers no answer (71 s, then
  "fetch failed"; a Wikipedia control reads in 0.5 s). Now a Google app link is refused at once, on
  the page and on the server, with the sentence that tells the reader to paste the article's own
  address or its text; `google.com/url?q=…` is unwrapped to its destination; a read shows its host
  and seconds ticking under the box and a failed read keeps its sentence there; "could not be
  reached" carries no jargon to the reader while the cause (a code) goes to /check's failure record;
  a read the page abandons is recorded as nothing. Guard: a link section of five checks.
- **18 September, 23:40 UTC: sites that keep their text.** The operator's link led to a Washington
  Post article behind a paywall. Probing twelve major sites through the service: seven refuse a
  server within a second (NYT, Reuters, AP, WSJ, Bloomberg, Politico, Economist), the Post never
  answers (the connection attempt times out at the operating system's ~71 s, cause ETIMEDOUT),
  the Atlantic answers with a shell, four give their text (BBC, CNN, CNBC, Guardian). Now each
  case is named to the reader by the site, in four languages, with what to do: refused, silent
  (found in ten seconds through a dedicated undici agent whose connect timeout is effective;
  remembered until restart with a background re-check; listed on /check), paywall (the schema.org
  flag Google News reads, a wall phrase in the prose, or 402; nothing tested whatever the site
  sent, the operator's rule), shell (no paragraph of prose, under 200 characters). Guard: six more
  checks in the link section, the silent site simulated with a listener whose queue is full.
- **19 September, 00:30 UTC: the second silence.** Live, the Post's first read still took 72 s
  after PR #39 (a connection attempt before the fetch): the cause was `ETIMEDOUT read`, so the
  connection and the handshake go through and it is the request that is never answered; the
  client's connect timeout had nothing to catch. Now the site agent's headers timeout is the same
  ten seconds (`SITE_SILENCE_MS` in server/http.js, the operator's figure), `UND_ERR_HEADERS_TIMEOUT`
  counts as silence, and the pre-fetch connection attempt of #39 is gone (undici's own connect
  timeout covers that face; the guard proves both faces: a listener whose queue is full, and one
  that takes every connection and never writes). Expected live: the Post found silent in about
  ten seconds on the first read, at once on the second.
- **19 September, 01:40 UTC: no link is refused by its shape.** The operator's rule: apply the same
  test to every link instead of assuming a Google app link cannot work (it can: Google resolves
  `goto?url=<token>` for any client, as a fetch of the operator's second link from outside Render
  showed, landing on a CNN article). The refusal of Google app links on the page and the server is
  gone; a Google link is tried like any other and, if google.com stays silent for the address, gets
  the same sentence as any other silent site in ten seconds and at once thereafter. A page with no
  prose that carries a meta refresh is followed like a redirect (the hop limit shared). Guard: the
  two refusal checks replaced by three (a goto-shaped link read where it leads, a meta refresh
  followed, a meta refresh loop ended).
- **19 September, 20:30 UTC: a marked article whose text arrived is shown.** With the Google link
  resolving (Google sent the server to the CNN article in 712 ms), the read stopped at CNN's subscriber
  marker under release E's rule although CNN sent the whole text (a metered wall). The operator
  chose: show the text and decide. A marked page with a paragraph of prose comes back with `wall:
  true`; the page puts the text in the box with `intake.markedWall` ("{site} marks this article as
  for subscribers; this is what it sent. If it is the whole article, press Test the facts. If not,
  copy the article's text and paste it here.") and does not start the run by itself; the next press
  runs it. A marked page with no paragraph of prose keeps the paywall sentence; 402 too. Guard: the
  paywall checks updated plus a no-prose teaser check and an unmarked-page check.
- **19 September, 21:30 UTC: YouTube again, and the video in the picture's box.** On the address a
  YouTube link failed with "caption track came back empty" (the track found on the watch page answers
  an empty body) or "no caption track": since 2026 the web player's caption files need a
  proof-of-origin token only a browser can make. Now the transcript comes through the player API as
  the Android app asks it (youtubei/v1/player, the watch page's own INNERTUBE_API_KEY, the caption
  file in json3), with the playability status read (LOGIN_REQUIRED and the like → "YouTube did not
  let CIVIC read this video from here. Paste the transcript text instead.", the reason on /check).
  The answer carries the video (embeddable, length, thumbnails); the page shows the player in the
  picture's box (an iframe on youtube-nocookie.com, 320 by 180 beside the steps, full width on a
  phone) or the thumbnail with a link when embedding is not allowed; no picture is generated for a
  video. The security policy admits frame-src youtube-nocookie.com and img-src *.ytimg.com. The
  guard stands in for YouTube (CIVIC_YOUTUBE_BASE). Caveat: YouTube blocks some cloud addresses
  outright; the live probe after the deploy is the proof.
- **19 September, 23:00 UTC: every door.** The operator's video (18adH9sRDAI) answered LOGIN_REQUIRED
  ("Sign in to confirm you're not a bot") to the Android door from the address, three times, while
  another video read in the same minute; the operator suspected their VPN, which plays no part (the
  server asks YouTube, not the reader's browser). Now the player is asked door by door in the
  operator's order (ANDROID, TVHTML5, WEB_EMBEDDED_PLAYER, ANDROID_VR, IOS; `CIVIC_YOUTUBE_CLIENTS`)
  with the watch page's visitor id, until one opens with captions. All shut → `url_video_wall` with the
  sentence pointing to YouTube's Show transcript panel, the record naming each door's answer; an open
  door on a video with no captions → the no-captions sentence. Guard: vid2 shut to ANDROID and open to
  TVHTML5, vid5 shut everywhere, vid6 open without captions.
- **21 September, 01:30 UTC: a formula is typeset, and a transcript service can be the last door.**
  The operator's determination wrote a stock-flow identity as display mathematics and the page showed
  giant bold fragments with no equals sign and no minus sign: Markdown reads a line holding only `=`
  or only `-` as an underline, deleting the operator and making a heading of the term above, so words
  the model wrote never reached the reader. Formulas are now parked under a name Markdown cannot touch
  (`splitMath`), restored after the sanitiser and typeset with KaTeX, vendored from node_modules like
  marked and DOMPurify; a lone dollar sign is never mathematics, because the model writes sums of
  money. Separately, the last door for a walled video is a hosted transcript service the operator sets
  (`CIVIC_TRANSCRIPT_URL`, `CIVIC_TRANSCRIPT_KEY`, and the header name and prefix): no vendor in the
  code, nothing asked until both are set, the key never leaving the server. Established for the
  record: no key exists for YouTube transcripts, from Google or anyone.
- **21 September, 09:40 UTC: the door fitted to a real service.** The operator signed up for Supadata
  (free tier, a hundred videos). Reading its API found two mismatches with the door built the night
  before. Its key rides raw in an `x-api-key` header, and the prefix setting could not be made empty,
  because the settings reader treats an empty value as unset and fell back to `Bearer`, which would
  have sent `Bearer sd_…` and been refused; the prefix now defaults to empty and the space before a
  named prefix is added in code instead of hiding in a setting's trailing blank. And it answers HTTP
  202 with a job id when it has to make a transcript itself, which the door read as no words; a job is
  now followed to its end (`CIVIC_TRANSCRIPT_JOB_URL`), bounded by the reader stopping the run rather
  than by a limit of ours. `.env.example` carries the four Supadata values; `mode=native` is the
  documented default, since it fetches captions a video already has for one credit while `mode=auto`
  also transcribes videos that have none, charged by the video's length.
- **21 September, 16:30 UTC: sources as tools (release L).** The operator will add hundreds of sources
  (LexisNexis, legal and financial databases) and wants each to be a tool the prompt can reach for
  without debt piling up. The architecture, agreed with the operator: one gateway at `/mcp` (the open
  standard, MCP) on CIVIC's own server, reached by the model through OpenAI's remote-tool door with one
  entry in the requests' `tools` list beside web search and no new parameter (`CIVIC_TOOLS_URL`,
  `CIVIC_TOOLS_PASS`; either unset, the requests are as before); few stable verbs
  (`server/tools/verbs.js`) and many sources behind them as adapters (`server/tools/adapters/`, one
  file each with a stand-in beside it, on when their settings are set, their keys never leaving the
  server); one result shape; a ledger line per call; the model choosing the source through a `source`
  parameter when a verb has several. The first source is the web through CIVIC's own reader
  (`read_page`, `get_transcript`). The guard runs every adapter through the gateway against its
  stand-in, and fails an adapter without one. The operator chose the wire (15:10 UTC): through
  OpenAI's MCP door rather than CIVIC running the tool loop itself (which would need
  `include: reasoning.encrypted_content`, a parameter never tested with, and several requests a
  claim). Set on Render with the merge: the gateway's address and a pass. Next: law (`search_law`,
  `get_case`; CourtListener first, LexisNexis as a second adapter behind the same verbs), then
  filings and financials (SEC EDGAR first).
- **21 September, 18:40 UTC: the model at its maximum power below GPT-6 (release M).** The operator
  asked for maximum power but not 6. OpenAI's pages that day: GPT-6 Astra at the top; GPT-5.6 Sol, CIVIC's
  model since the first build, the flagship below it, with two dials above CIVIC's `xhigh`: reasoning
  effort `max` and reasoning mode `pro`, "the highest-intelligence API option" short of Astra (more
  model work per answer, billed at Sol's ordinary rates, so more tokens and time per claim). Both are
  request parameters; the model, the prompts and the sources are untouched. Now: effort `max` and
  mode `pro` on both steps (`CIVIC_EFFORT`, `CIVIC_REASONING_MODE`; `standard` or empty sends no
  mode key), the mode on the card's model line and in the ledger, the guard admitting and requiring
  the key. Sol's estimate row corrected to OpenAI's price of that day ($4 in, $20 out, promotional
  through 21 November 2026; it said 5 and 30). The operator's next run, with their own data attached,
  is the proof; the YouTube test with their Supadata key follows it. The operator has integrated other
  sources directly into OpenAI and wants no source-related change until the two are understood.
- **22 September, 18:50 UTC: the transcript door opened and proven.** The door built in release K had
  been dark since 21 September because its four settings were not on the service. Three of them are not
  secrets, so `civic-web/scripts/render-env.mjs` now writes them from a session (PR #49: it refuses by
  name anything carrying KEY, PASS, SECRET, TOKEN, PASSWORD or CODES, so a key stays the operator's to
  paste, and `.claude/settings.json` allows exactly that command). `CIVIC_TRANSCRIPT_URL` carries
  Supadata's address with `mode=auto`, so a video with no captions is transcribed from its audio and
  comes back through a job with no limit of ours on the wait. The key was first saved under
  `CIVIC_TRANSCRIPT_KEy` — a lowercase final letter, and variable names are case-sensitive, so the app
  never saw it — and as a whole pasted line, key plus two trailing words; moved to the right name, the
  key alone, at the operator's instruction. Proof on the address: the video YouTube shuts at all five
  of its doors returns 26,618 characters of transcript in 10.7 s, a control still reads at YouTube's own
  first door, no failure record. CIVIC's first reach to an API outside OpenAI's ecosystem.
- **23 September, 13:10 UTC: back to three at a time, and the pace is a setting (release N).** The
  operator is watching tokens rise and asked to go back to three from four. Two things read rather than
  assumed: CIVIC's live request carries exactly one tool (six keys, web search alone; the evidence
  gateway is built but off), and the operator's tools are attached in ChatGPT, a different surface from
  the API key, so they cannot enter a CIVIC request or spend its minute. The likelier cause of the rise
  is ours: release M's effort `max` in mode `pro` is more model work per claim. So three (≈ 450,000 in a
  typical minute against 2,000,000) for a real reason. The pace also stops being a code change: the page
  reads `inFlight` from `/api/health` (`publicConfig`, beside `maxClaims`) and `IN_FLIGHT` stands in only
  when no server answers, so `CIVIC_EVAL_CONCURRENCY` moves both the number the page is told and the
  claims that run together — one setting, no release. The lede takes the number as a parameter in all
  four languages, so the page can never name a pace it is not running. The guard proves both: three
  together and never a fourth at the default, and two together and never a third with the setting at 2.
- **30 September: the door's locks, ahead of accounts (R0 of the commercial program).** Three
  explorers mapped the code for the accounts, credit and payment program and found a sign-in bypass:
  Express matches routes regardless of case while the gate compared the path in lower case, so
  `POST /API/extract` ran on the operator's key with no code and no count. Now routes match their
  case exactly and the gate is mounted on `/api` itself, so there is one reading of a path and
  `/API/extract` is nobody's route. With it: a job belongs to the sign-in that started it (another
  code cannot attach to, stop or let go of it: 403 `not_your_job`); an id of up to 128 characters is
  kept as given (a claim beyond the tenth has 81, which the old limit of 80 turned away, so a cut
  would have started a second paid determination) and a longer one is replaced by the server's,
  which the page then names; the cookie is signed with `CIVIC_SESSION_SECRET` when set, so a change of
  the OpenAI key no longer signs everyone out (/check flags it while unset); `CIVIC_OPERATOR_CODES`
  keeps the sign-in list and the runs per code to the operator; a request the browser marks as
  another site's is refused; and the page's one sign-in slot became a shared promise, so two actions
  refused together (the extraction and the picture start together) both proceed on one code instead
  of one waiting for ever. The program itself — accounts by email code, a Postgres ledger with holds,
  a price that scales with the document, Stripe, history — is in the plan and comes release by
  release; the operator's earliest own step is a domain, because sign-in codes cannot be mailed to
  readers without one.
- **1 October: the reader chooses (CIVIC_AUTO_TEST_FIRST).** The operator's instruction: start at
  zero automatic. How many of the claims found run without a press is now a setting the page reads
  from `/api/health` (`autoTestFirst`, ten unless set); the rest are listed with checkboxes, and the
  "Test N selected claims" button, parked since 18 September, runs them (the 81-character id that would
  have broken it was fixed in R0). At 0 nothing runs by itself: every claim found is shown with its
  checkbox, numbered from one, under "N claims found · choose which to test", and the intake's two
  sentences say the reader chooses, in four languages, from the same figures as the pace; until the
  server has answered, the page names no figure at all, so nothing flashes before the health reply.
  Set to 0 on the service before this merged, so the deploy carried it. This is the first piece of R3 pulled
  forward; the price on the button and the modes come with R3 itself. The same day: a Render Postgres
  (CIVIC, Basic-256mb, Ohio, 15 GB) was created by the operator and closed to the outside internet, and
  its internal address copied into the service as DATABASE_URL from Render's own API, never shown;
  nothing reads it until R1. The model switch to gpt-6.1-sol at effort xhigh (OpenAI's SDK 7.25.0 of 29
  September lists the model, `xhigh` and the `pro` mode; $2 / $0.10 / $10 per million by several
  published reports, OpenAI's own page being unreachable from the session) was refused to the session
  by its permission classifier twice, so it is the operator's, in Render's dashboard.
- **1 October, evening: a new OpenAI key, and the two sign-in settings.** The operator moved CIVIC's
  OpenAI key to another account of theirs and, in the same visit to Render's dashboard, set
  `CIVIC_SESSION_SECRET` (64 random hex characters made on their Mac, never seen by the session) and
  `CIVIC_OPERATOR_CODES` (their own code, the one allowed 150 runs), with one "Save and deploy"
  (`dep-davac3c1nsns73av5olg`, live 18:27 UTC, same build c91e41d8c251). The session had tried to set the
  two settings itself and its permission classifier refused a secret-store write, so the operator did
  all three. Proved from the session, read-only, nothing printed (11/11): the three names exact with no
  near miss, the key sendable, the secret 64 hex characters, the operator code the 150-run entry; the
  operator's code signs in on the new secret and is known as the operator's; /check ready, the key
  accepted for gpt-5.6-sol with no tokens spent, both warnings gone; the operator sees the sign-ins and
  every code's runs, and another code sees neither. Everyone signs in once more after this deploy. Not
  provable without a run: OpenAI has required a verified organization to stream its reasoning models
  and to return reasoning summaries, so the operator's first run on the new account is the last proof;
  a refusal would appear on the row in OpenAI's words, and pasting the old key back undoes it.
- **1 October, night: a refused article, found elsewhere.** The operator's Times link was refused to
  CIVIC's server (403), while ChatGPT summarised it in 2 minutes 39 seconds by keyword searches, reading
  The Straits Times' licensed republication. Measured from the session: a search built only from the
  link's words, its date and the line republishers print ("This article originally appeared in The New
  York Times") returned that republication first, and CIVIC's live server read it in 559 ms (6,703
  characters, the same quotes ChatGPT summarised). The first copy found by a broader search, on
  dnyuz.com, was a different Times article on the same speech, which is why the reader picks by headline
  and nothing chooses for them. The operator's link history since 18 September (Render's request log):
  15 reads by people, 5 read, 8 refused (half of them YouTube videos, which the transcript service now
  opens), 1 sign-in prompt, 1 stopped. Built: `server/copies.js` and `/api/find-copies`; the list under
  the box; the copy read by CIVIC's reader or, when its own site refuses CIVIC too, taken from the search
  service's text with the attribution saying so; the refusal's sentence reworded to say it is CIVIC's
  server the site turns away. Inert until the operator pastes `CIVIC_SEARCH_KEY` (Exa, dashboard.exa.ai);
  `CIVIC_SEARCH_URL` set from the session. Guard: a section of twelve checks with a stand-in search
  service; browser 8/8. Live (PR #53, build deaa2a51602c), after the operator pasted the key at 22:39 UTC:
  the Times link found 12 pages in 1.3 s, The Straits Times' republication first and credited, CIVIC's
  reader reading it (6/6). The same run showed some search texts are fragments (the Washington Post's
  845 characters, CNN's 1,000), so a copy taken from the search's text now waits in the box with a
  sentence for the reader's press, as a marked article does, and the list stays (browser 9/9).
- **2 October: the service is renamed FactEngine.** The operator's decision, with a design-tool mock of a home
  page for the new name (judged functional but dated; nothing of it is used but the name). This release renames
  every reader-facing occurrence: the four locales (15 keys each; the headline is a placeholder the operator
  edits), the page's title, description, wordmark (text, in the display font, in place of the CIVIC logo image;
  the final mark comes with the chosen design) and favicon (an SVG F inside the corner brackets), the server's
  sentences (refusals, the attribution lines that enter the prompt's slot, the check page's rows, the startup
  lines), the check page, the guard's expectations and the browser checks. Internal identifiers stay as they
  are: the CIVIC_* settings, the Render service and address, the package and file names, the cookie, the
  localStorage key, the MCP server label. The design itself is the next two releases: three directions shown as
  screenshots from the real app on the stand-in, then the chosen one built across the whole experience; the
  photographic background goes in all three (the operator's requirement), while the photograph stays as the
  echo's unseen style reference.
- **2 October, afternoon: the page's background is mathematics, under clearer glass (the design, release 3 of
  the rename).** The operator's brief after the three directions, in their words: keep and enhance the glass;
  behind it "something mathematical, anything from a math proof to designs that are known in mathematics, like
  the golden ratio, chaos" and fractals; "a design and not just part of a photo"; light, never dark, because
  "light clears up darkness and reveals truth"; glass because "truth has two factors", light and transparency;
  the whole "a mathematical proof that the truth has been created"; "there will be no dark mode". And, on the
  plan's first draft: nothing developed with a custom domain as a dependency; the domain waits until commercial
  deployment is near, and accounts and payments wait with it. Built, with no domain, key, secret or setting
  involved: `public/js/field.js`, a fixed, inert, aria-hidden layer behind every panel that draws ten fields
  from their own definitions (no picture file): four proofs typeset by KaTeX (Euclid IX.20, the irrationality
  of √2, Euclid I.47 as the windmill figure, Euler's identity), the golden rectangle and its spiral, the
  Mandelbrot set and a Julia set (`field-worker.js`, off the page's thread, at half resolution, kept for the
  phase's next visit), the Koch snowflake, the Lorenz attractor, a double pendulum's trace and the Ulam spiral.
  The field changes with the run, idle to extracting to evaluating to done, by one of two decks drawn once per
  visit, so every run shows all four kinds and the page is never the same twice; Start a new test returns the
  home field; reduced motion makes every change instant and stops the three fractals' slow drift. The glass is
  clearer (`--glass` .42, `--glass-strong` .56, blur 18 px, a sheen and a shine; `--ink-3` darkened so hints
  keep 4.7 : 1 and body text 14 : 1 on the worst backdrop); the sign-in dialog and the toast are light glass,
  and what the dialog dims is light, not darkness. The `.sky` band and the two smaller copies of the
  photograph are gone (712 KB fewer on the page); `civic-scene-1920.jpg` stays as the echo's style reference
  only. The check page holds the golden rectangle still. Proof: guard 177/177 with the real prompts; a new
  browser check (scratchpad/field-check.mjs, 19/19: the run drives the field through the deck's four fields
  and reset restores the home field; every field draws content of its kind; the fractals drift only at desktop
  width and never under reduced motion, where the change is instant; nothing widens a phone; the check page;
  the served files under the stamp; no CSP violation, no page error); copies 9/9, choose 10/10, pace 11/11,
  sign-in 6/6; leak check clean. The operator saw the ten fields under the home, then the whole page in eight
  states at both widths, before anything merged.
- **2 October, later: Unverified is grey.** The operator, on the screenshots: "They are usually in the grey zone,
  with strong but conflicting evidence. There is nothing brown (dirty) about these facts; they just cannot be
  resolved." The Unverified verdict had been dark amber since the first commit (never grey; the grey state was a
  verdict the page could not read). Now `--unv` is grey (#525c69 on #e9edf1) on the scoreboard, the badge, the
  brackets and the number of a done card; an unread verdict is dashed and hollow so the two never look alike; the
  amber stays for cautions only (a card's note, the check page's warning mark) under its own tokens. Rides PR #56.
- **2 October, evening: "Facts, verified.", and no figure in the intake sentences.** The operator on the design page:
  "It looks beautiful", with two changes: the tagline becomes "Facts, verified." ("more consistent with our naming
  conventions and gives me a little more latitude if I'm ever wrong"), and "and tests the first ten" goes ("that's
  development language"). So the lede reads "FactEngine extracts every empirical claim it contains; you choose which
  to test" (or "and starts testing them" when CIVIC_AUTO_TEST_FIRST is above 0), the sentence under the button names
  no figure ("Finding every claim takes a few minutes on a long document, because the model reads it all before
  writing. Each test you choose then takes a few minutes more."), and the step-2 header reads "Testing the claims you
  choose" until a batch starts, in all four languages (204 keys each). Rides PR #56, which merges on these words.
  **Live** (PR #56 squash e44ce31, deploy dep-davv67rm8hqs73cij3jg at 18:17 UTC, build 1ca43e214b90): the served
  page carries the field and no photograph, the clear glass, the grey verdict, "Facts, verified." and the choose
  sentence; field.js and field-worker.js under the stamp; the check page over the golden rectangle (the two deleted
  pictures' addresses answer the page itself, by the single-page fallback; the style reference is still served).
- **2 October, night: no brackets, one rounded box, a clearer glass, the commercial footer.** The operator, on the
  live page: "remove all blue brackets from the interface. It's too busy now with them. There should be one box type,
  and it should be the one with rounded edges"; the footer must carry "FactEngine.com · A service of
  OperatingEquity.ai", Terms, Privacy, Contact and © 2026 ("I'll worry about those pages later"); and "make the boxes
  a little less opaque so the text is clearly visible, but the glass effect is apparent". So: the corner brackets are
  gone from the intake, the echo and every card (the running state keeps its bar, the verdict its badge and number);
  every box is rounded, the sign-in dialog too; the glass is a shade clearer (`--glass` .36, `--glass-strong` .5,
  cards .48; body text still 14 : 1, hints 4.6 : 1); the footer has the site, the service, the three links and the
  year in four languages (209 keys each), and the three pages exist as one-sentence placeholders over the still
  field until the operator writes them. **Live** (PR #57 squash 9c51422, deploy dep-db00phff3r2c73ajijm0 at 19:58
  UTC, build 9172eb122a57; merged with the service idle, CI green in both shapes): the served page carries no
  bracket and no square frame, the footer names the site, the service, Terms, Privacy, Contact and the year, the
  stylesheet has no bracket rule, rounds the dialog and carries the clearer glass, /terms, /privacy and /contact
  are served as their own pages over the still field, and all four locales carry the footer words (11/11).
- **2 October, late: facts have a price, and every user is measured (release P).** The operator's program:
  "All empirical facts are parsed and listed for Free, and the user can then decide which or all to test,
  with 0 to 3 free facts, and cost and revenue measured for all users in each tier"; "the average needs to be
  marked up 25% to start"; "change every 6 hours unless one is very unprofitable and I am losing a lot of
  money. Become 1 until we earn it back"; "I need to test, measure, and optimize. It's absolutely critical."
  Built: `server/economics.js` (the tier fixed at a run's start and rotating every `CIVIC_TIER_HOURS` with a
  daily shift; one price for everyone fixed at each window's start from the measured average × 1.25, or
  `CIVIC_PRICE_START_CENTS` until twenty are measured, nothing priced until either exists; the loss guard to
  tier 1; revenue at list on done only, not collected; a failed determination keeps its cost and uses up no
  free one), `server/db.js` with `server/migrations/001-economics.sql` on the Render Postgres named CIVIC
  (`DATABASE_URL`, already on the service), every ledger line carrying its run, determination and owner, the
  page's Free marks and prices with the button's sum in four languages, the operator's measurement on /check
  (price and basis, tier clock, guard, per tier, per user, per window), `CIVIC_PRICING_ENABLED=false` as the
  rollback. The guard proves it on a real Postgres (its own cluster here; a service container in CI, required).
  The operator's figures still to set: `CIVIC_PRICE_START_CENTS` (without it nothing is priced until twenty
  determinations are measured, which /check counts) and `CIVIC_TIER_LOSS_GUARD_USD` (off until set).
  **Live** (PR #58 squash 03be08d, deploy dep-db01e7bm8hqs73cloag0 at 20:42 UTC, build 7f25548cbcc1; CI green in
  both shapes with the Postgres container; merged with the service idle): the boot log reads "measuring in Postgres ·
  schema 001-economics.sql applied"; the health line carries pricing (tier 4 at that hour, three free, no price yet
  because the start figure is unset and nothing is measured); the served page, script, stylesheet and four locales
  carry the price surface; the operator's /check carries the measurement from Postgres and another code's does not
  (15/15, scratchpad/live-pricing.mjs). The first real runs now put rows in the database and the measured average
  on /check.
- **2 October, 21:00 UTC: the first price is 49 cents, the operator's figure.** Asked whether the 45 cents in the
  pictures was data, the answer was no: a stand-in start figure for the pictures and the guard, and no real cost
  had ever been retained (the ledger lived on the instance and reset at each deploy; the persistent disk was never
  made; the server never logged costs). The operator chose to set a start price now: `CIVIC_PRICE_START_CENTS=49`,
  written to the service with render-env.mjs. With it, one fix: a window that began without a price would have kept
  its empty price until the next six-hour window (midnight UTC), so now a window without a price is asked again each
  time and takes the start figure the moment it is set and deployed; a window with a price keeps it until the next
  window; the measured price still arrives at the first window after the sample is complete. The operator, on the
  figure: "The cost changes based on api cost average fact run times x 1.25. $.49 is a guess. It may be high."; the
  sample stays twenty ("Ten is only a fraction of a single document"). **Live** (PR #59 squash 0550358, deploy
  dep-db03697f3r2c73amkorg at 22:42 UTC, build d8ad3b5f04a9; guard 191/191; CI green in both shapes): the health
  line carries priceCents 49, the operator's /check reads 49 cents, basis start, measured 0 of 20, in the window that
  had begun without a price (15/15, scratchpad/live-pricing.mjs). The page now marks the free claims and prices the
  rest at $0.49; the measured average × 1.25 replaces the guess after twenty determinations.
- **3 October, 07:40 UTC: the launch texts on the site.** The operator's word: "the text you created should go in the
  applicable sections on the site and be reviewed and changed, but I want things in place." The Terms of Service,
  Privacy Policy, Refund and Dispute Policy and Contact texts from the document "FactEngine: launch texts and
  checklist" (rev 13: 13+, parental permission under 18, purchases by adults; vendors by category only) are
  `public/terms.html`, `privacy.html`, `refunds.html` (new) and `contact.html`: static HTML in `.prose` over the still
  field, English only, each with a nav line to the other three, the support address as a link, and the
  placeholders in square brackets left as they are for the review. The footer gains Refunds, opens the four pages
  in a new tab (leaving the page cancels a run), and reads "A service of Fact Engine LLC, an Operating Equity
  company" (the operator's answer); under the results one sentence in four languages says determinations are
  made by an AI model from the sources it cites and can be wrong (222 keys per locale). The guard gains a pages
  section: each page served with its heading, the text and the address, no script but the field, no vendor, no
  key or token; the footer and the locales' new words. **Live** (PR #60 squash 3d7bd6c, deploy dep-db0is1avcj2c739c2chg at 16:34 UTC, build
  35616ee703d2; guard 209/209 with the real prompts; CI green in both shapes; browser 16/16): the four pages are served
  with their headings, the texts and the address, no script but the field and no vendor name; the footer carries the
  four links in a new tab and the Fact Engine LLC line; the AI line is in the page and all four locales (12/12,
  scratchpad/live-texts.mjs). The review and the placeholders are the operator's; counsel's reading is on the checklist.
- **3 October, 09:30 UTC: readers at once.** The operator: "I need to increase the number of simultaneous sessions
  because a service where you wait 20 minutes to start is a place you never come back to"; "Is each browser session
  talking to an api?"; "I am extremely worried that a mere 3 users is painfully slow and inefficient." The facts, read
  before anything changed: every browser talks only to FactEngine's server (one stream per determination, three at
  once per page), the server talks to OpenAI on the one key, and nothing of ours caps readers; the "3" was per reader.
  The key's minute now reads 40,000,000 tokens (the gate's own reading of OpenAI's headers; 2,000,000 in September; the
  tier-5 ceiling), so the budget is no longer the limit. Durations by people since 19 September (Render's request
  log): a determination 195 s median, 237 s at the 75th percentile, 339 s at most; an article's listing 93 to 315 s at
  max/pro (584 s once). The operator chose: ten at once per reader; the extraction's effort kept at max/pro and
  measured first. Built: `CIVIC_EVAL_CONCURRENCY` 10 (written to the service), the whole selection as one batch at
  that pace (no pause between tens); the gate sends in parallel, bounded by the bucket less the reservations of the
  sends whose headers have not arrived, the first of a kind alone (it teaches), listings before determinations, the
  readers in turns, a refused request first (gate.js; the reader's turn is the sign-in, else the run, else the job);
  the check page's pacing row shows what is in the air, reserved and waiting by kind and reader, and the readers with
  work in flight; the report carries how long determinations and listings take over the window, with the searches per
  determination (the figures to decide the extraction's effort by); the extraction's "Waiting its turn" survives the
  bar updater; the database pool and its wait are settings (10 connections, 30 s: an 8 s wait had lost the price row).
  Cached tokens count toward OpenAI's minute (its limiter runs before its cache), so caching cuts cost, never raises
  capacity; the 2 GB instance is the operator's step when readers arrive. Guard: ten at a time never an eleventh;
  the line's order in process; parallel sends; the reservation preventing overshoot on a budget of two; a listing
  first; two readers in turns; door and in-stream refusals; the pacing row mid-run; the durations in both stores. **Live** (PR #61 squash 7c96699, deploy dep-db0j20lg1s2s738pd2kg at 16:50 UTC, build b2add7a70cc8; guard
  221/221 with the real prompts and 221/221 in the stand-in shape; CI green in both shapes; browser 9/9: a twelve-claim
  selection as one batch with ten requests issued at once, six rows on plain localhost because Chromium opens six
  HTTP/1.1 connections per host, where the live service speaks HTTP/2 and ten streams multiplex; the held listing's
  "Waiting its turn · N s"): the health line tells the page ten and carries no pacing figure; the served app runs the
  whole selection as one batch; the four locales carry the timed waiting words; the operator's check data carries the
  pacing rows' air, reservations and waiting by kind and reader (no row yet: a gate's row exists from the instance's
  first request, and nobody has run since the deploy), the readers line and the report's durations (10/10,
  scratchpad/live-readers.mjs). The durations read zero: the one run since measurement began (01:51 UTC, under a
  reader's code) was cut nineteen seconds in, before its listing finished, so nothing was recorded; the operator's
  next run is the first figure. One addition beyond the plan: the per-request claims cap became a setting
  (`CIVIC_MAX_CLAIMS`, 10 unless set), because the guard's twelve-claim request needed it and the figure was a constant.
- **4 October: the listing on DeepSeek flash.** The operator: "I want use DeepSeek flash for the generating of
  empirical claims. It is 10 times faster and better. I have an api key. Tell me where to put it and name." Read from
  DeepSeek's own pages that day: DeepSeek answers OpenAI's Responses API at `https://api.deepseek.com` with the same
  stream events, runs web search on its side, honours `reasoning.effort` (none, low, high, max), makes no reasoning
  summary (it streams its whole chain of thought instead) and has no mode; `deepseek-flash` is DeepSeek-V4.1-Flash
  (1M context); its price per million tokens is input $0.30, cached $0.006, output $1.20 at peak hours (01:00-04:00
  and 06:00-10:00 UTC, Monday to Friday) and half otherwise; its limit is 2,500 requests in flight, answered with a
  429 that names no wait; it closes a request not started within ten minutes. Its terms: data processed and stored in
  the People's Republic of China under PRC law, and a small, de-identified part of user input may be used for
  training unless opted out (privacy@deepseek.com). The operator's answers: effort **max**; the chain of thought
  **kept off the page** (it restates the prompt's instructions in the model's words); the Privacy page **updated in
  this release**. Built: `CIVIC_EXTRACT_PROVIDER` (openai unset, deepseek), `DEEPSEEK_API_KEY` (the operator's, pasted
  in Render; the session's attempt to store it from chat was refused by the safety rules, so it is theirs to paste),
  `CIVIC_DEEPSEEK_BASE_URL`; the listing's body on DeepSeek is the model, the prompt verbatim, `reasoning.effort`, one
  `web_search` and `stream`, nothing else; the client takes nothing of OpenAI's from the environment; no gate for
  DeepSeek (no per-minute figures to pace by), a 429 or a 503 goes again a second after the go began, an error event
  mid-stream is read as the stream's own, a stream ended without its last event is a cut connection; a 401 or 402
  shows the reader FactEngine's own sentence and /check DeepSeek's words; key refusals (OpenAI's too) no longer name a
  provider or a key on the page; /check reads DeepSeek's key, model and balance without a token (the figures to the
  operator alone); DeepSeek's prices with the hour; the Privacy page's model-provider line split in two (the
  listing's provider processes data in China and its terms allow a small, de-identified use of inputs unless opted
  out; the determinations' provider does not train on inputs), its transfer sentence names China, and the Terms say
  "model providers". Guard: a DeepSeek section on a stand-in that speaks DeepSeek's dialect. **Live** (PR #62 squash
  5444a9f, deploy dep-db1enh2vcj2c73a6eprg at 00:14 UTC on 5 October, build 494d2d74792d; guard 241/241 with the real
  prompts; CI green in both shapes; browser 5/5): the health line names the listing's provider, OpenAI until the
  switch; the Privacy and Terms pages carry the new sentences; the served page shows a 402 as the operator's sentence;
  the operator's /check is ready (7/7, scratchpad/live-deepseek.mjs). The switch waits for the key: when
  `DEEPSEEK_API_KEY` is on the service, `CIVIC_EXTRACT_PROVIDER=deepseek` is written and a deploy carries both; then
  `live-deepseek.mjs after` and one short listing are the proof.
- **5 October: OpenAI back to its setting before 21 September, and the listing on Fireworks.** The operator: "Do
  you have a DeepSeek key in place? I want to send the email, but I need to identify the account. Maybe someone in
  the US is hosting the model so we can avoid the China issue. The truth is, it's not their societal strength; it's
  stealing intellectual property. I'm going to use their top model later and compare it to the one we are using; the
  switch made costs balloon, and the quality is lower, as I saw the model not pulling empirical questions out [...]
  This model is expensive and terrible—10 minutes and $3.40 for a simple question." Measured: no DeepSeek key was
  ever on the service, so DeepSeek never received anything; the run they saw was OpenAI's gpt-5.6-sol at effort
  `max` in mode `pro` (the setting of 21 September): in Postgres on 4 October the listing took 927 s and $3.81, one
  determination 404 s, 12 searches and $3.71. Their answers: the listing to **a US host (Fireworks)**; the
  determinations **back to the setting before 21 September**; on search, "Does the DeepSeek model have no search.
  How can it work?" (no model searches by itself: the service running it performs the searches it asks for).
  Read from Fireworks' own pages that day: DeepSeek V4.1 Flash as `accounts/fireworks/models/deepseek-v4p1-flash`,
  $0.22 input, $0.007 cached, $0.66 output per million tokens; its Responses API keeps a conversation 30 days
  unless `store: false` and otherwise retains nothing (zero data retention for open models; no training on inputs
  without opt-in); serverless runs on its fleet in the United States, Frankfurt, Iceland and Tokyo, its US-only
  serverless covering two other models; tools of type function or mcp (an mcp server is called by Fireworks itself),
  no web search; the chain of thought comes inside the answer's text, ahead of `</think>` (its examples read the
  answer after it); usage as `prompt_tokens` / `completion_tokens`. Three choices made on the operator's behalf
  where they had not answered, each one word to reverse: FactEngine's own search (not Fireworks' own, which needs
  Fireworks to switch it on for the account), Fireworks' pay-per-token service (not a US-only setup), and the
  OpenAI listing stepped down too until the switch. **Done at 02:36 UTC:** `CIVIC_EFFORT=xhigh` and
  `CIVIC_REASONING_MODE=standard` written with `render-env.mjs` and deployed with the service idle
  (dep-db1gpthsrm7s73bkb3ug): both OpenAI steps read effort xhigh and no mode on the health line; the code's
  defaults follow in the release. **The release:** `CIVIC_EXTRACT_PROVIDER=fireworks` with `FIREWORKS_API_KEY`
  (the operator's, pasted in Render) and `CIVIC_FIREWORKS_BASE_URL`; the providers behind one seam
  (`server/listing.js`), OpenAI's settings kept from every other provider (`server/providers.js`); the body on
  Fireworks is the model, the prompt verbatim, `reasoning.effort` max, one `mcp` entry naming FactEngine's tool server
  and `store: false`, nothing else; the tool server's address is `RENDER_EXTERNAL_URL` + `/mcp` (Render sets it) and
  its pass is derived from the session secret, so nothing new is pasted, and OpenAI's requests still name the tool
  server only with both `CIVIC_TOOLS_*` set; a new verb `search_web` answered by the search service already on the
  service (each call at the service's own price on its ledger line); the chain of thought cut at `</think>`
  (`ThoughtCut`) so no reasoning becomes a claim or reaches the page, the replay, the raw listing, the ledger or a
  failure record; Fireworks' usage read into the price table; its echo of the effort on the ledger line; /check reads
  the key and the model without a token and whether the tool server answers at its public address; the Privacy and
  Terms texts stop saying China and are true before and after the switch (the listing's provider does not train on
  inputs and may search through our search provider; data may be processed in the United States, Europe and Japan),
  the launch-texts document matching (rev 24). Later that day the operator: "I think we need to go back the model we
  were using previously. The cost has gone up 10 x and the processing time huge." Already so since 02:36 UTC (the same
  model, GPT-5.6 Sol, at the setting before 21 September; no other model ever ran); the Fireworks switch is held for
  their word. **Live** (PR #63 squash cc52046, deploy dep-db1hbj6q1p3s73fanc4g at 03:13 UTC, build 87804ceab1f1; guard
  267/267 with the real prompts; CI green in both shapes; browser 5/5): both steps on gpt-5.6-sol at effort xhigh with
  no mode key; /privacy and /terms without China and with the new sentences; the operator's /check ready with the
  listing on OpenAI and the search verb among the tools (6/6, scratchpad/live-fireworks.mjs).
- **5 October, the switch to Fireworks, and why it went back.** The operator: "I want the first pass pulling empirical
  statements from text to be on deepseek flash and I have the new key" (a Fireworks key, pasted in Render; its deploy
  live at 03:50 UTC). `CIVIC_EXTRACT_PROVIDER=fireworks` was written and deployed (live 03:51 UTC); the first live
  listing failed: Fireworks answered 500 "Internal server error" after its servers had called the tool server ten times
  (POST /mcp in Render's request log), each refused with 401. Fireworks does not forward an `mcp` entry's headers, and
  the pass was in them. The listing went back to OpenAI at once (`CIVIC_EXTRACT_PROVIDER=openai`, live 03:52 UTC); no
  reader was affected. The fix: each listing's request names a door of its own in the address, `/mcp/t/<door>`
  (`server/tools/doors.js`): 24 random bytes, open from the moment the request is made until its reply ends, then
  shut. The entry carries no header, the derived pass is gone, and nothing new is pasted. /check opens a door of its own,
  asks the tool server for its tools at the public address through it, shuts it and proves it refused. The stand-in
  Fireworks now forwards no header either, so the guard reproduces the live failure whenever the door is missing.
  **Live** (PR #64 squash b22e780, deploy dep-db1ibhlg1s2s739midjg at 04:24 UTC, build cbbf14f11689; guard 269/269 with
  the real prompts; CI green in both shapes; browser 5/5). Fireworks' MCP client (python-httpx, the standard Python
  library) sends the headers the tool server requires. `CIVIC_EXTRACT_PROVIDER=fireworks` written and deployed with the
  service idle (dep-db1id96gekts73dvrpv0, live 04:25 UTC). Live proof under the operator's code: a three-sentence
  listing completed in 136 s with exactly its three claims, no reasoning text, Fireworks' echo of effort max, and a
  ledger cost of $0.0045. Render's request log shows Fireworks at the listing's door three times (initialize 200,
  initialized 202, tools/list 200), none refused; the model made no search for three plain facts; no door was left
  open. The first pass now runs on DeepSeek V4.1 Flash at Fireworks; determinations stay on GPT-5.6 Sol at effort xhigh.
- **5 October, the first pass thinks at "high".** The operator, after their first article on Fireworks: "It is taking
  over 7 minutes to extract claims from a small article. We may need to reduce from max. It should[n't] think so much."
  - What was read: their listing started at 04:37:42 UTC. Fireworks connected to the tool server once and the model
    made no search, so the whole time was thinking at `max`. The three-sentence test had taken 136 s at `max`.
  - DeepSeek's own documentation for V4 Flash lists four levels: none, low, high and max. Medium and xhigh map to high,
    and high is DeepSeek's default with thinking on.
  - DeepSeek's published scores for Flash at non-think / high / max: 71.2 / 87.4 / 88.1 on GPQA Diamond, and
    83.0 / 86.4 / 86.2 on MMLU-Pro.
  - The operator's answer: **High**. `CIVIC_EXTRACT_EFFORT=high` was written with `render-env.mjs` and deployed once
    the service was idle, so their run was not cut.
  - The code's default for Fireworks and DeepSeek follows (`server/config.js`), so a lost setting cannot bring `max`
    back.
- **5 October, the first pass on DeepSeek's own service.**
  - The operator's article at "high" on Fireworks took 4 min 55 s. Fireworks serves DeepSeek V4.1 Flash at about 50
    tokens/s, against about 211 at DeepSeek's own service (public benchmarks; ModelIndex measures Fireworks at 48).
  - Fireworks' price for the model is $0.30 / $0.006 / $1.20 per million since 1 October (its release note), corrected
    in PR #65.
  - Offered low thinking on Fireworks, a faster US host, DeepSeek's own service or OpenAI, the operator chose DeepSeek's
    own service, which they had ruled out that morning ("Fireworks sucks").
  - They saved the key in Render themselves at 15:12–15:18 UTC, as `DEEPSEEK_API_Key`, with the last three letters
    lowercase. Names are case-sensitive, so the release reads a key under its name whatever its capitals:
    - the exact name wins;
    - two spellings holding different keys are used neither;
    - /check names the spelling.

    `render-env.mjs` now refuses a key's name whatever its capitals.
  - The Privacy page goes back to the operator's wording of 4 October: the listing's provider "processes data in China,
    and its terms allow it to use a small part of the inputs it receives, de-identified, to improve its models unless we
    opt out", and the transfer sentence names China.
  - `CIVIC_EXTRACT_PROVIDER=deepseek` is written before the merge, so the release's deploy carries the provider, the
    key's reading and the text together.
  - **Live** (PR #66 squash cc68553, deploy dep-db1saglckfvc73e51u3g at 15:42 UTC; guard 273/273 with the real
    prompts; CI green in both shapes). Live proof 5/5 under the operator's code:
    - the health line reads deepseek-flash at high;
    - /privacy names China in the 4 October wording;
    - /check accepts DeepSeek's key and model, with a balance of $19.73;
    - the three-sentence listing took 14 s and $0.0019 (58 s on Fireworks at high, 136 s at max), with its three claims
      and no reasoning text.

    Rollback: `CIVIC_EXTRACT_PROVIDER=fireworks` and a deploy.
- **Then stage 3:** the Mac copy is closed and the URL bookmarked; both copies share one key's
  minute budget, so they never run at once.

- Stage 0 (code) is done and merged: sign-in by code (server/access.js, the dialog on the page,
  CIVIC_ACCESS_CODES), one request per claim with a cut stream requested again, /api/health
  reporting `active` and `access`, SIGTERM closing the listener, the upload cap, render.yaml.
  The guard has 85 checks; the door and the per-claim run are proved in the browser.
- Stage 1 is done. The Render GitHub app is installed on the Operating-Equity organisation with
  access to civic-001 and on the personal account Halseyminor500; the claude.ai environment has
  network reach to api.render.com and *.onrender.com and carries RENDER_API_KEY and
  OPENAI_API_KEY. What blocked it for three hours, for the record: Render's `POST /v1/services`
  answered 400 "repository URL is invalid or unfetchable" for the private repository because the
  Render account logs in with, and deploys as, the GitHub user **halseyminor500-creator**, a second
  GitHub account of the operator's that is not a collaborator on civic-001; the app installations
  cannot change that. Render allows one connected GitHub account per Render account, and login and
  deployment must be the same GitHub account when both use GitHub (render.com/docs/login-settings).
  The private-repository fix, should it ever be wanted, is the operator's, on Render's Account
  Settings page, Account Security section, in this order: Create Password; disconnect the GitHub
  login method halseyminor500-creator; disconnect the Git Deployment Credential
  halseyminor500-creator; Add credential → GitHub, authorising as Halseyminor500. The public API
  has no endpoint for any of this.
- The Render workspace id (the API's ownerId) is tea-dak7rhnqj5pc73a4dj50; the service id is
  srv-dam9vlrm8hqs73d28tk0. The API reads its deploys (`GET /v1/services/{id}/deploys`), its logs
  (`GET /v1/logs?ownerId=…&resource={id}`), its variables and secret files, and triggers a deploy
  (`POST /v1/services/{id}/deploys`).
- The repository root's render.yaml is the blueprint to follow when creating the service through
  the API (rootDir civic-web, Node 22, npm install / npm start, health check /api/health).
- Work on the branch the session is given; changes reach main by pull request, squash-merged
  after the verify workflow is green, as every earlier change did.
- First actions for the session that picks this up: `curl -sS -o /dev/null -w '%{http_code}'
  https://api.render.com/v1/services -H "Authorization: Bearer $RENDER_API_KEY"` must answer 200;
  `https://civic-c64i.onrender.com/api/health` must answer with `active` and `access`; then the
  stage 2 items above that are still open.

# CIVIC to the cloud: from the Mac to a Render URL, with sign-in by code

(The previous plan in this file, the connection-wait fix, is merged as PR #27 and installed.)

## Context

CIVIC runs on the operator's Mac today: an installer, a Terminal window, `localhost:3000`, the
OpenAI key in a settings file beside the server. The run of 17 September showed the weakness: a
lost route on the laptop is a lost run. The operator always meant to run it in the cloud and
wants every step, from the Mac to no Mac, with development continuing without complexity, no
domain yet, no database, and the focus kept on the app.

The cloud account exists: a Render workspace ("My Workspace", Hobby plan, workspace id
`tea-dak7rhnqj5pc73a4dj50`), created after I pointed the operator
at Render on 15 September. The repository root already carries `render.yaml` (Node 22, `rootDir:
civic-web`, `npm start`, health check `/api/health`, prompts as secret files at `/etc/secrets/`,
`OPENAI_API_KEY` set in the dashboard). No service exists on it yet.

Sign-in is a precondition, not an option: a public URL means anyone could spend the operator's
key. The operator's design: the page's existing **Sign in** button opens a space for a
seven-character alphanumeric code and an email address; five codes are pre-generated by me; only
the code gates; the email is recorded, not checked; no database.

## What I can and cannot reach from this sandbox (verified 17 September)

- **Render is unreachable from here.** `render.com`, `api.render.com`, `api-docs.render.com`
  and `*.onrender.com` are all refused by this environment's network policy (the proxy answers
  403 to the connection, before anything leaves). GitHub and code.claude.com are allowed. So
  today I cannot create the service, set its variables, read its logs, or even open the deployed
  site to check it. `api.openai.com` is blocked too, which is why every test here uses the
  stand-in.
- **The operator can give me hands, in one dialog at claude.ai/code.** The environment editor
  (the cloud icon above the message box → the settings icon on the environment) has two things:
  1. **API credentials** (Pro and Max plans): a Render API key stored on the environment with
     allowed website `api.render.com`, header `Authorization`, prefix `Bearer`. The proxy adds it
     to my requests after they leave the sandbox; the key never enters the sandbox, and the host
     becomes reachable without changing the access level.
  2. **Network access → Custom**, allowed domains `*.onrender.com` (and `api.render.com`, to be
     safe), with "Also include default list of common package managers" checked, so I can open
     the deployed site, run the check page, and see whether a run is in flight before a merge.
  Environment changes apply to sessions started afterwards. This session keeps its policy, so
  the plan is committed to the repository (`civic-web/docs/cloud.md`, no secrets) before the
  switch, and the next session starts from it.
- **What only the operator can do, whatever the path:** install Render's GitHub app on the
  `Operating-Equity` organisation with access to `civic-001` (a GitHub authorisation in the
  browser; the operator is the organisation owner), and add a card under Render → Billing.

## The Render facts that shape the plan (from Render's published pages)

- A single HTTP response may last up to 100 minutes. One request per claim keeps every response
  far under it (a claim is 5 to 15 minutes; today's batch is 25 to 50 in one response).
- A deploy boots the new instance, gates on the health check, switches traffic, then SIGTERMs
  the old instance 60 seconds later and SIGKILLs it 30 seconds after that: a run still streaming
  on the old instance is cut. So merges happen only when the service reports no run in flight,
  and the page requests a cut claim again.
- Free instances spin down after 15 minutes idle; Starter is $7/month always on (512 MB, 0.5
  CPU); Standard $25/month (2 GB). Secret files: 1 MB combined, encrypted at rest. Persistent
  disks $0.25/GB/month but they cost zero-downtime deploys. Preview environments need the $25
  Pro workspace; a second $7 service on the working branch does the same (stage 4).
- Render's REST API (`api.render.com/v1`, bearer key) creates services, sets environment
  variables, uploads secret files, triggers deploys, and reads logs.

## Stage 0: make the app cloud-ready (me, in code, one pull request)

1. **Sign-in by code.** `server/access.js` reads `CIVIC_ACCESS_CODES` (comma-separated). When it
   is set: every `/api/*` route except `/api/health` and `/api/signin` requires the sign-in
   cookie; the page itself, its files and `/check`'s HTML stay public; `/check`'s data
   (`/api/selftest`) needs the cookie, and the check page says "Sign in on the main page first"
   when it lacks one. `POST /api/signin { email, code }`: the code is compared case-insensitively
   against the list; on a match the cookie is set: email, the code's hash, and an HMAC keyed by
   that code, so removing one code from the list signs out exactly its holders and nobody else.
   `HttpOnly`, `SameSite=Lax`, `Secure` behind HTTPS (`app.set('trust proxy', 1)`), lifetime
   400 days (the longest a browser accepts; the code, not the clock, decides). `POST /api/signout`
   clears it. `/api/health` reports `session: { email } | null` so the nav can show who is in.
   A wrong code: the field stays and the dialog says "That code is not on the list." Nothing is
   counted and nothing locks: seven characters from an alphabet of 31 (A–Z and 2–9 without the
   look-alikes 0, O, 1, I, L) give 27 billion codes; guessing is hopeless without any limit.
   The email is written to a sign-in log (`CIVIC_SIGNIN_LOG`, temporary on Render, and to the
   server's log stream, which Render keeps) and shown on `/check` under "Recent sign-ins". With
   the variable unset (the Mac, the guard, the stand-in) nothing changes.
2. **The page.** The existing **Sign in** button opens a `<dialog>` with two fields, email and
   code, and one button. Any API call answered 401 `signin_required` opens the same dialog, and
   the action that was refused (Test the facts, reading a link, testing selected claims) proceeds
   on its own once the code is accepted. After sign-in the nav shows the email and **Sign out**;
   **Sign up** stays as it is until accounts exist. Strings in en, es, fr, de.
3. **One request per claim** (`public/js/app.js` `runBatch`). The page keeps four claims in flight (two, then three, then four on 18 September),
   each its own `/api/evaluate` stream with one claim, the source and its attribution as now;
   the server's gate goes on pacing OpenAI across requests. A stream that ends without the
   claim's `done` is requested again a second later ("The connection to CIVIC was cut · going
   again"); only that claim's attempt is lost. `retryClaim` already does this for one claim;
   `runBatch` becomes a loop over it with four workers.
4. **Deploy awareness.** `/api/health` reports `active` (streams open now). On SIGTERM the server
   stops accepting new connections and lets open streams finish within Render's grace.
5. **Fit the instance.** `CIVIC_MAX_UPLOAD_BYTES` 64 MB on Starter (an upload is held whole in
   memory and parsed there; 512 MB must hold it with room); Standard keeps 200 MB.
6. **`render.yaml`**: the `civic` service on `main`, `autoDeploy: true`, region Ohio,
   `CIVIC_ACCESS_CODES` declared with `sync: false` (its value lives only in Render), the upload
   cap, `CIVIC_ALLOW_PRIVATE_URLS` false stated. Optional `civic-staging` (stage 4).
7. **Five codes**, generated with `crypto.randomInt` from the alphabet above, delivered to the
   operator as a private file (as the installer was), set in Render (by me through the API, or
   pasted by the operator). Never in the repository, never in chat text.
8. **README** and **`civic-web/docs/cloud.md`** (this plan, without secrets) so a fresh session
   can continue it.
9. **The guard**: with codes set, `/api/extract` without the cookie is refused; `/api/signin`
   with a listed code sets the cookie and with an unlisted one does not; `/api/health` stays
   open; removing a code from the list signs out its holder and no one else; the per-claim run
   completes with four in flight and never five; a browser run with the stand-in killed
   mid-claim: that claim is requested again and every claim completes; the sign-in dialog opens
   from the button and from a refused action, and the action proceeds after the code.

## Stage 1: what the operator sets up (Path A chosen; the Render API key already exists)

Exact locations. The claude.ai steps are quoted from its documentation; the GitHub link is the
one Render's own documentation gives; the Render dashboard items are the ones visible in the
operator's screenshot (left pane: Billing; top bar: "+ New").

1. **Render's GitHub app on the organisation.** Open
   `https://github.com/apps/render/installations/new` in the browser signed in as
   Halseyminor500. Choose the account **Operating-Equity** (not the personal account). Choose
   **Only select repositories** → **Select repositories** → `civic-001` → **Install** (or
   **Install & Authorize**; if the button reads **Request**, an organisation owner must approve).
   Then, in Render, the credential that lets the account act as that GitHub user (installing
   the app on GitHub does not create it; Render's page render.com/docs/git-provider): open
   **Account Settings** (`https://dashboard.render.com/u/settings`, the page where the API key
   was created), scroll to **Account Security**, and under **Git Deployment Credentials** the
   GitHub row must read **Halseyminor500**. If it reads another GitHub account (it read
   halseyminor500-creator on 18 September), first **Create Password**, then disconnect that
   account under **Login Methods** and under **Git Deployment Credentials**, then **Add
   credential** → **GitHub** in a browser whose GitHub session is Halseyminor500; GitHub's page
   names the account it authorises; confirm. Check: **+ New** (top bar) → **Web Service** lists
   `Operating-Equity/civic-001`. Close the page without creating anything (the service is
   created by me, through the API).
2. **A card.** Render, left pane, under WORKSPACE → **Billing** → the payment-method section →
   add the card. Starter is $7 a month; OpenAI usage is unchanged.
3. **Give me reach and the key, at claude.ai/code, in one dialog.**
   a. Open `https://claude.ai/code` and click **+ New** at the top of the left sidebar, so the
      screen for starting a new session is showing. (Inside a running session, the cloud icon in
      the header only opens an information popover reading "Cloud environment: Default"; it has
      no settings. That is what the operator saw first.) On the new-session screen, in the row
      directly above the message box, there is a cloud button labelled **Default**. Click it.
   b. In the menu, under the heading **Cloud**, hover over **Default** (the row with the
      checkmark); a settings icon appears at its right edge. Click it. The **Update cloud
      environment** dialog opens. Nothing needs to be typed in the message box; the new session
      is not started.
   c. **Network access**: set the selector to **Custom**. In **Allowed domains**, one per line:
      `api.render.com` and `*.onrender.com` (asterisk, dot, name; `*onrender.com` without the
      dot is refused with a red note, as the operator saw). Tick **Also include default list of
      common package managers**.
   d. **The Render API key.** The operator's dialog has no **API credentials** section (their
      claude.ai plan is one without it; the dialog ends at Setup script), so the key goes in
      the **Environment variables** box of the same dialog as one line, `RENDER_API_KEY=` followed
      by the key, nothing else. The dialog notes that these values are visible to anyone using
      the environment; this environment is personal to the operator's account, and the key can
      be revoked in Render at any time (Account Settings → API Keys). Every session started in
      the environment then has the key as an ordinary environment variable, and I use it in
      requests to `api.render.com`; it is never written to the repository or shown in chat.
   e. Click **Save changes**.
4. **Tell me it is done.** I test the reach from here. The documentation says environment
   changes (variables, and in practice the network policy) apply to sessions started
   afterwards, so this session will most likely not get them. Then I save this plan into the
   repository (`civic-web/docs/cloud.md`, no secrets) and the operator starts a new session:
   **+ New**, the same environment **Default**, the repository `civic-001`, and the one-line
   message "Continue the CIVIC cloud plan in civic-web/docs/cloud.md". That session has the
   reach and the key, and carries the work from there.
5. **The OpenAI key** is not "pushed": it never touches the repository. I set it in Render's
   environment from my copy, over Render's API. The five codes and the two prompt files go the
   same way, as secret files and a variable, never in the repository.

## Stage 2: first deploy and proof

1. Deploy; the service answers at `https://civic-<id>.onrender.com`. Sign in with a code.
   `/check` shows: key present and usable; prompts present, extract `f798309e`, evaluate
   `c52121a0`; build stamp equal to `main`'s commit; no recent failures.
2. A real run on the CNBC article of 17 September, on the URL, with the Mac copy closed: 25
   claims, ten tested two at a time, verdicts and cost as on the Mac.
3. A deploy while idle: I merge a one-line change; the service rebuilds and switches in about
   two minutes; the page's build stamp changes; a run started afterwards completes.
4. One deliberate redeploy during a run, to see the cut claim requested again and complete.

## Stage 3: the Mac steps aside

1. Close the CIVIC Terminal window. The Desktop launcher stays as an offline fallback; never run
   both at once, since both share one key's minute budget.
2. Bookmark the URL; replace the pinned CIVIC tabs that point at `localhost:3000`.
3. The rhythm from then on: I change the code → pull request → the guard's checks → I merge only
   when `/api/health` reports `active: 0` → Render deploys itself in about two minutes → the
   operator refreshes. No installer, no download, no Terminal.
4. Rollback: one click in Render, or I revert the merge.

## Stage 4: later, each one step

1. **Domain**: Settings → Custom Domains → one CNAME at the registrar → certificate automatic.
2. **Accounts**: Sign up and per-person sign-in replace the code list; the cookie becomes the
   session. The email field already collected is the beginning of that list.
3. **Persistent ledger**: a 1 GB disk ($0.25/month) if `/check`'s history should survive deploys.
4. **Staging**: a second Starter service ($7/month) on the working branch, same secrets, so the
   operator tries a change at its own URL before I merge.

## Costs

Render Starter $7/month; $7 more for staging if wanted; $0.25/month for a disk if wanted.
OpenAI usage unchanged.

## Verification

- Stage 0: `npm run verify` in all three prompt shapes with the new checks, the leak check, and a
  Playwright run of the sign-in dialog, a refused action proceeding after the code, the
  per-claim streams, and the stand-in killed mid-claim.
- Stage 2 is the proof in the cloud: `/check`, the real run, the idle deploy, the deliberate cut.

## Known differences from the Mac

- Links are read from Render's servers; a few sites block datacenter addresses. Pasted text,
  uploads and the model's own web search are unaffected.
- The ledger, the sign-in log and `/check`'s history reset on each deploy until a disk is added;
  Render's own log stream keeps the sign-in lines.
- Both copies share one OpenAI key; the Mac copy stays closed.
