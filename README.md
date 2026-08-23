# amp-reviewbot

`amp-reviewbot` is a GitHub App that reviews pull requests in fresh [Amp orbs](https://ampcode.com/manual/orbs) and publishes the result as a GitHub check run with line annotations.

Each review gets an Amp thread labeled `reviewbot`. GitHub delivery IDs and a Postgres job queue make webhook handling idempotent, and a newer PR revision cancels an obsolete review.
Review threads are archived after each run; the corresponding GitHub check keeps a direct link to the archived thread.

## How it works

```text
GitHub pull_request webhook
  -> Fly.io service verifies the signature and queues a job
  -> worker creates an "Amp Review" check run
  -> Amp SDK starts a fresh orb for the repository's Amp project
  -> Amp reviews base SHA...head SHA and returns structured JSON
  -> service validates changed paths and publishes annotations
```

The service keeps the GitHub App private key. Review orbs receive repository access from their Amp project, but never receive the GitHub App credential.

Reviewbot keeps one self-contained [`general-code-reviewing`](.agents/skills/general-code-reviewing/SKILL.md) skill under `.agents/skills`. Its ship-risk and simplicity passes are embedded directly into every review prompt without skill metadata, so target-repository orbs do not depend on globally installed skills.

## Requirements

- Node.js 22+
- Postgres
- An [Amp access token](https://ampcode.com/settings/security)
- An Amp project for every reviewed repository
- A GitHub App

By default, GitHub repository `owner/repo` resolves to Amp project `owner/repo`. Set `AMP_PROJECTS` when the names differ:

```json
{"owner/repo":"workspace/project-name"}
```

## Create the GitHub App

Create a GitHub App with:

- **Webhook URL:** `https://YOUR-HOST/webhooks/github`
- **Webhook secret:** a random secret also supplied as `GITHUB_WEBHOOK_SECRET`
- **Checks:** read and write
- **Contents:** read
- **Pull requests:** read
- **Subscribe to events:** Pull request

Checks write permission automatically enables the `check_run` events used by GitHub's **Re-run** control.

Install the App on repositories that have corresponding Amp projects. The Amp account behind `AMP_API_KEY` must be allowed to start orb threads for those projects.

## Configure

Copy `.env.example` and provide:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `DATABASE_SSL` | Set `true` when the server requires TLS |
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_PRIVATE_KEY` | GitHub App private key; escaped newlines are accepted |
| `GITHUB_WEBHOOK_SECRET` | Secret used to verify webhook signatures |
| `AMP_API_KEY` | Amp access token used by the SDK |
| `AMP_PROJECTS` | Optional repository-to-project JSON map |
| `AMP_THREAD_VISIBILITY` | `private` (default) or `workspace` |
| `WORKER_CONCURRENCY` | Concurrent reviews, default `2` |
| `REVIEW_TIMEOUT_MINUTES` | Per-review timeout, default `30` |
| `FAIL_ON` | Lowest failing severity, default `high` |

Run locally:

```sh
npm install
npm run build
npm start
```

The service exposes `GET /healthz` and `POST /webhooks/github`.

## Deploy to Fly.io

Choose a globally unique Fly app name in `fly.toml`, then create and attach Postgres:

```sh
fly launch --no-deploy
fly postgres create
fly postgres attach YOUR-POSTGRES-APP
```

Set secrets without committing them:

```sh
fly secrets set \
  AMP_API_KEY='...' \
  GITHUB_APP_ID='...' \
  GITHUB_PRIVATE_KEY="$(cat github-app.pem)" \
  GITHUB_WEBHOOK_SECRET='...'
```

If project names need overrides:

```sh
fly secrets set AMP_PROJECTS='{"owner/repo":"workspace/project"}'
```

Deploy:

```sh
fly deploy
```

Pushes to `main` deploy automatically after typechecking, tests, and the build pass. Configure an app-scoped Fly deploy token as the repository Actions secret `FLY_API_TOKEN` to enable the workflow.

Deployment changes external state; review the Fly application, region, database, and secret configuration before running these commands.

## Repository preparation and security

Orbs run the project's committed `.agents/setup` before the review. Keep setup deterministic and ensure the trusted default branch is prepared for orb use.

Pull-request contents are untrusted. The review prompt explicitly avoids executing lifecycle hooks, service definitions, and instructions modified by the PR. For repositories accepting untrusted forks:

- Do not place production credentials in the Amp project.
- Be aware that workspace secrets apply to every workspace orb.
- Configure review tools and permissions at the Amp project level; SDK tool restrictions are local-only and are ignored by the orb executor.
- Treat tests and package lifecycle scripts from a PR as arbitrary code.

The initial implementation receives the final review through the Amp SDK stream. Amp OIDC is therefore not needed. If asynchronous orb callbacks are added later, use `amp orb id-token --audience ...` rather than a static callback credential.

## Check conclusions

- No findings: `success`
- Findings below `FAIL_ON`: `neutral`
- At least one finding at or above `FAIL_ON`: `failure`
- Superseded review: `cancelled`
- Review infrastructure error: `failure`

Amp output is schema-validated and capped at 20 findings. Findings outside GitHub's changed lines are omitted from annotations.

## Development

```sh
npm run typecheck
npm test
npm run build
```

## License

MIT
