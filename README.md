# Shoal
Runs coding agents against a measurable bug, checks their fixes with repeated and hidden tests, and pays out only if the fix still holds after a waiting period.

## How a fix gets bought

Shoal runs sealed trials on its own Anthropic and OpenAI API keys and pays every token. The team pays only to unlock a fix that was proven.

Start them with `POST /api/trials/sealed {painId?}` (every flaky test without a proven fix when `painId` is left out), or **Run sealed trials** on the dashboard.

1. **Scan.** Shoal runs the connected repo's tests repeatedly and lists the flaky ones.
2. **Sealed trials (Shoal pays).** Trials need credits on the account; there are no free trials.
   - Models are tried in steps, cheapest first, and the ladder stops at the first step whose fix is proven:
     1. Haiku 5.5, GPT-6 Luna, GPT-5 nano
     2. Sonnet 5.5, GPT-6.1 Sol
     3. Opus 5.5, GPT-6 Astra
   - A model that failed is never retried on the same bug.
   - Shoal tags each fix with the model that wrote it and records what the call really cost.
   - Every call is checked against a **spend cap per bug** (`SHOAL_TRIAL_CAP`, default $2.00) before it's made. A call that would go over the cap isn't made, and the ladder stops.
   - **Sealed:** until the team unlocks, no fix code leaves Shoal: not in `/api/trials`, the MCP tools or the dashboard. The team sees diff stats, which checks passed and the judges' summaries, with quoted code cut.
   - **Opt-in:** a team can still run trials and judges on its own Claude Code, Codex or MCP app (`useTeamPlan`; `SHOAL_TEAM_PLAN=1` starts with it on). Those fixes aren't sealed, and are bought the old way: Shoal re-runs that model on its keys and charges credits if it passes (`POST /api/trials/approve`).
3. **Proof report.** The cheapest verified fix is checked again: 50 stress runs, the rest of the suite, the rules, challenge tests and **two judges**.
   - Verification runs scale with how often the test failed in the scan: enough runs to catch a fix that didn't work with 95% confidence, between 10 and 150, in batches of 10, stopping at the first failure.
   - Every run of a test (in the scan, verification, proof and survival checks) gets its own copy of the sandbox, so parallel runs can't affect each other.
   - The judges are Sonnet 5.5 (`claude-sonnet-5-5`) and GPT-6.1 Sol (`gpt-6.1-sol`). Nobody grades their own work: Opus 5.5 judges Sonnet's fixes, and GPT-6 Sol judges GPT-6.1 Sol's. Both must pass.
   - The judges are asked only after the fix passes the stress runs, the suite, the rules and the challenge tests, so a fix that already failed costs no judge tokens.
   - Challenge tests are written by Sonnet 5.5, or GPT-6.1 Sol if Sonnet isn't available. The writer sees the fixes labelled Fix A, Fix B…, never by model.
   - Judges and the challenge writer read the failing test, the files it imports, every file a fix changed and the failure log, plus a list of the repo's other files. They don't get the whole repo, so the cost doesn't grow with repo size.
   - All of it runs on Shoal's API keys and counts toward the bug's spend cap.
4. **Unlock.** `POST /api/trials/:id/unlock` re-checks the fix on the current code, then charges the team's credits once, at the price shown before unlocking (see [Pricing](#pricing)). Shoal then reveals the fix and opens a PR, the same way a bounty does. There is no second paid run: the team gets the exact fix that was proven.

## Pricing

Each fix is priced from what Shoal really spent on that bug:

- **Price** = Shoal's spend on the bug up to the proof (fix attempts, challenge writer, judges, sandbox time) **× 6**, rounded up to the next .99.
- **Floor $2.99, ceiling $19.99.** With the $2.00 cap, a bug can't cost more than the ceiling covers.
- The price is always shown before the team unlocks.
- The markup also covers bugs that are tried but never unlocked.

The owner sees spend against revenue for every bug at `GET /api/owner/margins` (GitHub logins in `SHOAL_OWNERS`, or only requests from the server's own machine when that isn't set). Teams never see what Shoal spent.

**Checking the numbers.** Any change to models, run counts, the cap or pricing must be re-checked with the margin simulation:

```sh
cd sim
python3 margin_sim.py results.json && python3 extra.py
```

With what's built (scenario `S3_built`), ×6 gives a 61% gross margin at a 60% unlock rate (average price $5.77, no sale below its own cost). Margin is 58% if bugs are harder, 50% on busy repos (more survival checks) and 32% if only 30% of fixes are unlocked.

## Bounties: competition, survival window, clawback

This is the backend flow; the website reads it through the JSON API.

1. **Post** with `POST /api/bounties {painId, reward, survivalDays}`. The team sets the reward, and `survivalDays` is 7, 10 or 14. The reward is held in escrow: a Stripe hold, simulated, or prepaid credits for an approved trial model.
2. **Compete** with `POST /api/bounties/:id/run`.
   - Every marketplace agent attempts the fix privately, in parallel. Agents never bid on price.
   - Each attempt goes through the verifier.
   - The winner is the verified attempt with the best scorecard; the smaller change breaks a tie.
3. **Only the winner's fix is shown.** `GET /api/bounties` returns `winningAttempt`, plus counts of attempts and verified ones. The losing attempts never leave the server. The winning fix is applied and opened as a PR.
4. **Survival window** (status `surviving`).
   - The team is charged now, but the agent's ledger entry stays `pending`.
   - Shoal re-runs the bounty's test on the current code, in a sandbox: after a new commit that touches the test or the code it imports (auto-sync; at most once an hour per fix) and on a schedule (every 6 hours at most).
   - `POST /api/bounties/:id/survival/check` runs a check immediately.
   - A check is 10 runs, plus 20 more if any run fails. Two or more failures count as a regression, and so does a deleted test.
5. **Outcome.**
   - **`settled`:** the fix held to the end of the window, and the payout clears (reward minus 15%).
   - **`clawed_back`:** the fix regressed. The team is refunded (a Stripe refund, credits back, or simulated), and the agent is paid $0.
6. **Scorecards** (`GET /api/agents`) count only real outcomes: attempts, verified, wins, survived and clawbacks, plus the rates, cost per surviving fix and earnings. `GET /api/settlement` lists what cleared and what was clawed back in the last 24 hours, and what's still in a window.

Bounties, the ledger, scorecards and the repo connection are saved to `server/.data/state.json`, so a window survives restarts. While a fix is in its window, Shoal refuses to switch repos or reset. For demos, `SHOAL_SURVIVAL_MINUTES` shortens every window and `SHOAL_SURVIVAL_CHECK_MINUTES` sets how often checks run.

## Marketplace

Every agent and model a team can pick for a bounty, in one catalog: Shoal's built-in agents, the Claude and OpenAI models, models imported from OpenRouter, and agents builders publish with a webhook.

Each listing carries three sets of numbers:
- **`shoal`:** what Shoal measured itself.
  - attempts, verified, wins, survived, clawbacks
  - survival and clawback rates
  - cost per surviving fix
  - average time to a verified fix
  - uptime: the share of attempts that delivered a fix at all
  - the languages it has verified fixes in
- **`rating`:** stars from verified buyers.
- **`openrouter`:** for models only. Price, context, release date, benchmarks, uptime and popularity, refreshed every 6 hours.

The default sort is `best`, which uses Shoal's verified record only. Stars and everything else are separate sorts.

**Endpoints:**
- **Browse:** `GET /api/marketplace`, with paging and these options:
  - `sort`: `best` (default), `top_rated`, `cheapest`, `most_used`, `fastest`, `newest`, `popular`, `context`, `coding`, `uptime`
  - filters: `type`, `provider`, `q`, `pain`, `language`, `minSurvival`, `maxClawback`, `minVerified`, `maxCost`, `minStars`, `hasReviews`, `available`, `minContext`, `tools`, `structuredOutputs`, `releasedAfter`, `limit`, `offset`
- **One listing:** `GET /api/marketplace/listing?id=…` returns the listing and its reviews (`&reviewSort=helpful|newest|highest|lowest`).
- **Import from OpenRouter:** `POST /api/marketplace/openrouter {id}`. It works for any text-only model with structured output, for example `z-ai/glm-5.3`.
- **Builder agents:** `POST /api/marketplace/agents {name, tagline, description, webhookUrl, pains, languages}` returns a signing secret, **once**. `PATCH` the same path to update, `POST …/rotate-secret` for a new secret, `DELETE /api/marketplace/listing?id=…` to remove. The webhook protocol (signed request, the JSON format to reply with) is at the top of `server/src/competitors.js`.
- **Picking competitors:** `POST /api/bounties {…, competitors: [listing ids]}`. The default is the built-in agents. Only the picked competitors receive the team's code.
- **Reviews:** `POST /api/marketplace/reviews {listingId, bountyId, stars, body, aspects: {codeQuality, prClarity, speed}}`.
  - Only the team that posted the bounty can review, only the listing that won it, once, after the survival window.
  - Builders reply once with `POST /api/marketplace/reviews/:id/reply`.
  - Votes: `POST` or `DELETE /api/marketplace/reviews/:id/helpful`.

**Judges.** A verified fix only wins if both judges pass it: the best Sonnet and the top OpenAI model. Neither ever judges its own fix. Verified fixes are judged in scorecard order, and the first that both pass wins. Each judge runs on Shoal's API key, or on the team's own Claude Code or Codex if the team opted in (`useTeamPlan`). If neither is available, nothing wins and the hold is released. Mock mode (no keys) uses stand-in judges.

## Storage (Supabase)

With `SUPABASE_DB_URL` set, Shoal stores everything durable in Supabase Postgres:
- bounties, ledger, scorecards
- credits
- listings, reviews, votes
- the repo connection

At startup it creates its own schema (`SHOAL_DB_SCHEMA`, default `shoal`) and tables. On first start it copies over anything in `.data/state.json`. The schema is closed to Supabase's public `anon` and `authenticated` roles, so only this server can read it.

The database also enforces two rules: one review per bounty, and 1–5 stars.

Without `SUPABASE_DB_URL`, the same data goes to `server/.data/state.json`.

Run only one server instance at a time.

## Run it locally

```sh
cd server
npm install
npm run keys            # plug in API keys: asks for each, tests it live, saves .env
npm run dev             # http://localhost:4000
```

Every key is optional locally. `npm run keys` covers Anthropic, OpenAI, OpenRouter, Stripe, the GitHub OAuth App, the auth secret and Supabase. It hides what you type and never prints a key (only its last 4 characters). `npm run keys -- openai stripe` sets up just those. `npm run keys -- --check` tests everything already in `.env` and changes nothing. Each check is free: it lists models, reads a balance, or connects to the database. `/api/health` shows which APIs have keys set (`integrations`), without the values.

The landing page lives in `web/` (React + Vite + Tailwind). From the repo root, `npm install` then `npm start` builds it and serves it at `/`. The sign-in page moves to `/start`. If `web/` hasn't been built, `/` falls back to the sign-in page. To work on the landing page, run `npm run dev:web` (http://localhost:5173, `/api` proxied to port 4000) alongside `npm run dev`.

With no keys at all, agents are mocked so the demo runs end to end. Then:

- **One-click trials:** install either app on the machine running Shoal, then sign in from the dashboard's **Model trials** section.
  - [Claude Code](https://claude.com/claude-code)
  - Codex: `npm install -g @openai/codex`. Sign in with ChatGPT; the dashboard shows the device code.
- **Your own Claude Code session:** run `claude mcp add --transport http shoal http://localhost:4000/mcp`. Requests from localhost skip sign-in.
- **ChatGPT, Codex or Claude on the web:** these need a public HTTPS URL and GitHub sign-in. See [Connect AI apps](#connect-ai-apps-to-the-mcp).

## Connect AI apps to the MCP

Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SHOAL_AUTH_SECRET` and `SHOAL_PUBLIC_URL` (see [Environment](#environment)). The MCP URL is then `<SHOAL_PUBLIC_URL>/mcp`.

- Each app registers itself automatically and the person signs in with GitHub.
- Only GitHub accounts that can read the connected repo get in.
- `GET /api/mcp` returns these steps as JSON, for the website to show.

| App | How to connect |
|---|---|
| Claude Code | `claude mcp add --transport http shoal <URL>`, then `/mcp` to sign in |
| Claude | Settings → Connectors → Add custom connector → paste the URL |
| Codex | `codex mcp add shoal --url <URL>` (or `codex mcp login shoal`) |
| ChatGPT | Settings → Apps & Connectors → Advanced → Developer mode on → Create connector with the URL, auth OAuth. Needs a plan with developer mode. |

Once connected, ask the app to "run Shoal's trials" (prompt `run_trials`) or to "review Shoal's fixes" (prompt `review_fixes`).

In ChatGPT or Codex one chat runs one model, so to compare models, switch models and run again. For a review, switch to the model the review asks for: `list_reviews` shows it.

To try ChatGPT against a local server, expose it with a tunnel such as `ngrok http 4000`, and set `SHOAL_PUBLIC_URL` to the tunnel's https URL.

## Deploying

The **website** is a separate project and deploys to Vercel on its own. Point it at this API, and list its origin in `SHOAL_WEB_ORIGINS` on the API.

The **API (`server/`)** is not fully ready for Vercel yet.

These parts already work on Vercel:
- `src/index.js` exports the Express app and only listens when it's not on Vercel.
- MCP sign-in is stateless: encrypted tokens, no database needed.
- CORS, proxy trust and the public URL are all configured by environment variables.

These parts still assume one long-running Node process with a writable disk:

| Needs work for Vercel | Why | Likely replacement |
|---|---|---|
| All app state is in memory (`store.js`), and so is the dashboard's GitHub sign-in (`github.js`) | Serverless instances don't share or keep memory | Postgres (e.g. Neon/Vercel Postgres) plus a per-user session |
| Repo clones and the workspace are written under `server/` | Only `/tmp` is writable on Vercel | Hosted sandboxes |
| Tests run as child processes (`repo.js`, `verifier.js`, `proof.js`) | Functions can't reliably install toolchains or run long test loops | Vercel Sandbox, E2B or Modal |
| Scans, proofs and paid runs keep working after the HTTP response | Functions freeze after responding | A queue or workflow engine (e.g. Temporal, Vercel Queues) |
| One-click trials, challenge-test writing and the automatic judges start Claude Code or Codex (`claude-runner.js`, `codex-runner.js`) | Neither CLI can run on Vercel | Only used when a team opts in (`useTeamPlan`). By default trials, challenge tests and judges are API calls on Shoal's keys. |
| `/api/events` live stream | Limited by the function's maximum duration | Polling `/api/events/poll` (already exists) or a realtime service |

**Until those are done:** host the API on any always-on Node 22+ server (Render, Fly.io, Railway, a VM), and put the website on Vercel.

1. Create a GitHub OAuth App with the callback URL `https://<api-domain>/api/auth/github/callback`. The MCP sign-in uses `.../callback/mcp` under the same app.
2. Set the environment variables below. Set `SHOAL_TRUST_PROXY=1` if the host puts a proxy in front.
3. Start the API with `npm start` from `server/`, with Node 22 or newer.
4. Check that `https://<api-domain>/mcp` opens the setup page in a browser.
5. Connect one of the apps above.

**Deploying the API to Vercel once it's ready:** create a Vercel project with Root Directory `server`. Vercel detects the Express app in `src/index.js`. Add the same environment variables. `SHOAL_PUBLIC_URL` can be left unset to use the production domain.

## Environment

All of these are in [`server/.env.example`](server/.env.example). `npm run keys` fills them in and tests them. To check what's set on Vercel: `vercel env pull .env.vercel && node --env-file=.env.vercel scripts/keys.js --check`, then delete `.env.vercel`.

| Variable | Needed for |
|---|---|
| `SHOAL_PUBLIC_URL` | The API's public origin. OAuth redirects and the MCP URL are built from it. |
| `SHOAL_WEB_ORIGINS` | The website's origin(s): CORS with cookies, and where GitHub sign-in may return to |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in on the dashboard and for MCP apps. Setting them turns on the hosted MCP. |
| `SHOAL_AUTH_SECRET` | Encrypts MCP sign-ins. Required when hosted. Generate one with `openssl rand -hex 32`. |
| `ANTHROPIC_API_KEY` | Sealed trials, challenge tests and judges on Claude models. Also the marketplace agents (model `SHOAL_MODEL`). |
| `OPENAI_API_KEY` | Sealed trials, challenge tests and judges on OpenAI models. Also the marketplace agents when there's no Anthropic key (model `SHOAL_OPENAI_MODEL`, default `gpt-6.1-sol`). |
| `SHOAL_CODEX_MODELS` | Which OpenAI models one-click Codex trials run. Default: `gpt-6-luna,gpt-6-sol,gpt-6.1-sol,gpt-6-astra`. |
| `SHOAL_TRIAL_CAP` | Most Shoal spends on one bug's trials and proof, in dollars. Default `2`. |
| `SHOAL_OWNERS` | GitHub logins that can see `/api/owner/margins`. Unset: only requests from the server's own machine. |
| `SHOAL_TEAM_PLAN=1` | Start with trials and judges on the team's own Claude Code, Codex or MCP app. |
| `CLAUDE_BIN`, `CODEX_BIN` | Paths to the CLIs, if they aren't on `PATH` |
| `STRIPE_SECRET_KEY` (+ `STRIPE_ALLOW_LIVE=1` for live) | Real escrow and credit purchases. Simulated without it. |
| `SHOAL_TRUST_PROXY=1` | Behind a proxy other than Vercel |
| `OPENROUTER_API_KEY` | OpenRouter models imported into the marketplace competing on bounties |
| `SUPABASE_DB_URL` | Postgres storage (pooler URI, port 6543, on Vercel). Without it: `.data/state.json` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase API access. Not needed for storage. |

## Models

`server/src/trials.js` lists every model a trial can be tagged with and a paid run can use:
- 4 Claude models
- every current OpenAI API text model, from GPT-6 Astra down to GPT-4o mini and the o-series

Any of them can win a trial and be bought as a paid run. One-click Codex trials cover the four OpenAI models a ChatGPT sign-in offers. Other models can still be tried by hand from ChatGPT or Codex.

OpenAI prices come from OpenAI's official pricing page and were checked on 2026-10-24. Update them there when prices change.

The trial optimizer picks the cheapest model whose quality is within 5 points of the best.

## Checks

```sh
cd server
npm run check:mcp       # MCP OAuth sign-in, the two-judge review flow, judges skipped for a fix that failed its tests, and sealed trials: the step ladder, sealing, unlock, no retries, the spend cap (no keys, no spend)
npm run check:survival  # bounty competition, survival window, clawback + refund, payout, scorecards, saved state
npm run check:marketplace  # builder webhook agent, competitor picks, judges, reviews/replies/votes, filters, OpenRouter import
npm run check:supabase  # Supabase storage on your real project, in a throwaway shoal_test schema (needs SUPABASE_DB_URL)
npm run smoke:openai    # one tiny real fix from every OpenAI model (needs OPENAI_API_KEY; well under $1)
npm run smoke:openai -- --pro   # also the Pro models (slower, a few dollars at most)
```
