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
  gone; the picture is now an edit of the CIVIC photograph (the page's own background,
  `public/assets/civic-scene-1920.jpg`, the file the operator attached), sent with every request
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
3. **One request per claim** (`public/js/app.js` `runBatch`). The page keeps three claims in flight (two until 18 September),
   each its own `/api/evaluate` stream with one claim, the source and its attribution as now;
   the server's gate goes on pacing OpenAI across requests. A stream that ends without the
   claim's `done` is requested again a second later ("The connection to CIVIC was cut · going
   again"); only that claim's attempt is lost. `retryClaim` already does this for one claim;
   `runBatch` becomes a loop over it with three workers.
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
   completes with three in flight and never four; a browser run with the stand-in killed
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
