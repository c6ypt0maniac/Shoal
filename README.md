# Shoal
Runs coding agents against a measurable bug, checks their fixes with repeated and hidden tests, and pays out only if the fix still holds after a waiting period.

## How a fix gets bought

1. **Scan.** Shoal runs the connected repo's tests repeatedly and lists the flaky ones.
2. **Trials (free to Shoal).** The team's own AI app connects to Shoal's MCP server and tries fixes on the team's own plan. Each fix is tagged with the model that wrote it, and Shoal verifies every one but applies none.
   - **One click on the dashboard:** Shoal drives whichever apps are signed in on the machine, at the same time.
     - **Claude Code** runs Haiku, Sonnet and Opus on the team's Claude plan.
     - **Codex** runs GPT-6 Luna, GPT-6 Sol, GPT-6.1 Sol and GPT-6 Astra on the team's ChatGPT plan. Those are the OpenAI models a ChatGPT sign-in offers in Codex.
   - **By hand:** connect Claude, ChatGPT, Codex or Claude Code to the MCP URL and ask it to run the trials.
3. **Proof report.** The cheapest verified fix is checked again: 50 stress runs, the rest of the suite, the rules, challenge tests and **two judges**.
   - The judges are the best Sonnet (`claude-sonnet-5-5`) and the top OpenAI model (`gpt-6-astra`).
   - Nobody grades their own work: Opus 5.5 judges Sonnet's fixes, and GPT-6.1 Sol judges Astra's.
   - Both judges run on the team's plan. Shoal asks Claude Code and Codex automatically when they're signed in. Otherwise each judge answers over MCP from the team's app. Both must pass.
   - Challenge tests are written by Opus through Claude Code, or by GPT-6 Astra through Codex.
4. **Paid run.** The team buys the proven fix. Shoal runs that model through **Shoal's own API keys** (Anthropic or OpenAI), verifies the result, and charges credits only if it passes.

Trials and judging never use Shoal's API keys. Only the paid run does.

## Run it locally

```sh
cd server
cp .env.example .env    # fill in what you need; everything is optional locally
npm install
npm run dev             # http://localhost:4000
```

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
| One-click trials, challenge-test writing and the automatic judges start Claude Code or Codex (`claude-runner.js`, `codex-runner.js`) | Neither CLI can run on Vercel | Leave as local-only. Both judges already work over MCP. Challenge tests need a new home: an MCP task for the team's app, or a paid API call. |
| `/api/events` live stream | Limited by the function's maximum duration | Polling `/api/events/poll` (already exists) or a realtime service |

**Until those are done:** host the API on any always-on Node 22+ server (Render, Fly.io, Railway, a VM), and put the website on Vercel.

1. Create a GitHub OAuth App with the callback URL `https://<api-domain>/api/auth/github/callback`. The MCP sign-in uses `.../callback/mcp` under the same app.
2. Set the environment variables below. Set `SHOAL_TRUST_PROXY=1` if the host puts a proxy in front.
3. Start the API with `npm start` from `server/`, with Node 22 or newer.
4. Check that `https://<api-domain>/mcp` opens the setup page in a browser.
5. Connect one of the apps above.

**Deploying the API to Vercel once it's ready:** create a Vercel project with Root Directory `server`. Vercel detects the Express app in `src/index.js`. Add the same environment variables. `SHOAL_PUBLIC_URL` can be left unset to use the production domain.

## Environment

All of these are in [`server/.env.example`](server/.env.example).

| Variable | Needed for |
|---|---|
| `SHOAL_PUBLIC_URL` | The API's public origin. OAuth redirects and the MCP URL are built from it. |
| `SHOAL_WEB_ORIGINS` | The website's origin(s): CORS with cookies, and where GitHub sign-in may return to |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in on the dashboard and for MCP apps. Setting them turns on the hosted MCP. |
| `SHOAL_AUTH_SECRET` | Encrypts MCP sign-ins. Required when hosted. Generate one with `openssl rand -hex 32`. |
| `ANTHROPIC_API_KEY` | Paid runs on Claude models. Also the marketplace agents (model `SHOAL_MODEL`). |
| `OPENAI_API_KEY` | Paid runs on OpenAI models. Also the marketplace agents when there's no Anthropic key (model `SHOAL_OPENAI_MODEL`, default `gpt-6.1-sol`). |
| `SHOAL_CODEX_MODELS` | Which OpenAI models one-click Codex trials run. Default: `gpt-6-luna,gpt-6-sol,gpt-6.1-sol,gpt-6-astra`. |
| `CLAUDE_BIN`, `CODEX_BIN` | Paths to the CLIs, if they aren't on `PATH` |
| `STRIPE_SECRET_KEY` (+ `STRIPE_ALLOW_LIVE=1` for live) | Real escrow and credit purchases. Simulated without it. |
| `SHOAL_TRUST_PROXY=1` | Behind a proxy other than Vercel |

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
npm run check:mcp       # MCP OAuth sign-in end to end + the two-judge review flow (no keys, no spend, no Claude/ChatGPT plan use)
npm run smoke:openai    # one tiny real fix from every OpenAI model (needs OPENAI_API_KEY; well under $1)
npm run smoke:openai -- --pro   # also the Pro models (slower, a few dollars at most)
```
