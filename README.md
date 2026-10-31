# multipi

A shared, durable coding room: multiple people, one Pi agent, one isolated Linux checkout, and one attributed transcript.

**Experimental prototype, not production-ready or approved for sensitive repositories.** Generated code and model-authored tests require human review. Archive is not deletion, and model usage limits are admission checks—not hard billing caps.

## Features

- Owner/operator/observer roles, membership revocation and presence.
- Follow-up and steering inputs, queued withdrawal, Stop, checkpoint restore and recovery controls.
- Durable shared transcript, reconnect synchronization and identity-scoped submit outbox.
- Native Linux Bash/filesystem tools, process-tree cancellation and R2 workspace checkpoints.
- Captured-byte patch review, download and durable command-result evidence.
- Separately approved, digest-bound draft PR publication through a selected-repository GitHub App. Publication is not a model tool.

## Stack

TypeScript, React, Vite, Cloudflare Workers, SQLite Durable Objects, native Containers, R2, Access and Workers AI. The agent uses the official `PiHarness`/`Lifecycle` integration with pinned Agents `0.31.0` and Pi Durable/AI/Chord `1.4.0`; there is no second agent engine or terminal proxy.

## Requirements

- Node.js 24 and pnpm 12.5.1.
- Docker for native execution, container tests and image builds.
- Brave for browser tests; set `MULTIPI_BRAVE_EXECUTABLE` if it is not at the default platform path.
- For real repository workflows: your own Cloudflare account with the required paid services, an Access application, and a selected-repository GitHub App installation.

The workspace explicitly permits install scripts only for the pinned esbuild/workerd versions and denies unnecessary dependency scripts. Review new build-script requests rather than approving all dependencies.

The native Containers integration uses experimental, version-pinned APIs. Validate platform availability before deploying; do not substitute a weaker executor silently.

## Local development

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm dev
```

Open the localhost URL printed by Vite. Local development selects `wrangler.local.jsonc`, a fixture model and localhost-only development identity. It does not use your personal Pi credentials or local extensions.

The UI can start without live credentials. Creating a real repository room still requires GitHub App credentials and an explicit repository/principal grant in your ignored `.dev.vars`. The fixture model is for development, not a coding-quality evaluation. Use the test suites below for self-contained room/UI fixtures.

Never enable `LOCAL_DEV` or deploy test configurations on a public hostname.

## Checks

```sh
pnpm check                 # Typecheck, unit/client tests, real workerd/DO tests, production build
pnpm format:check
pnpm test:ui               # Brave UI/IndexedDB smoke with mocked HTTP/socket APIs
pnpm test:e2e              # Two Brave contexts against a local Worker/DO fixture
```

With Docker running, run the native checks serially:

```sh
pnpm build:image
pnpm test:container
pnpm test:native
pnpm test:recovery
```

Native checks exercise filesystem/process behavior, checkpoint backup/restore, cancellation and local recovery. They do not prove hosted isolation, provider-outage behavior or production readiness. Test-only crash probes must never be deployed.

## Hosted setup

Use your own account, resources, identity policy and repository allowlist. No deployment credentials, live account identifiers or private staging configuration are included.

### 1. Prepare configuration and Access

On a fresh checkout, create a local configuration; do not overwrite an existing one:

```sh
cp wrangler.staging.example.jsonc wrangler.staging.jsonc
```

The copied file is ignored by Git. Edit it for your account and resources:

- Worker name, R2 bucket and any account/domain settings.
- `ACCESS_TEAM_DOMAIN`: your Cloudflare Access team domain.
- `ACCESS_AUDIENCE`: the exact application audience.
- `APP_ORIGIN`: the exact HTTPS application origin.
- `ALLOWED_REPOSITORIES`: JSON mapping canonical `owner/repository` names to explicitly permitted identity emails. Room membership and repository grants are separate checks.
- `MODEL_ID`: a supported Workers AI coding/tool model. Validate its streaming, reasoning settings, metadata and pricing before use. Some models cannot disable reasoning; an omitted setting may select expensive defaults.
- `WORKSPACE_INSTANCE_TYPE`: choose capacity deliberately. The example uses `standard-1`; omitted size uses the platform's smaller default. Review costs before deployment.
- `MAX_ROOM_TOKENS` and `MAX_ROOM_COST_USD`: soft, between-request admission thresholds. Provider cancellation does not guarantee immediate billing termination; use independent spending controls.

Provision the named R2 bucket and protect the entire origin with Access, including UI, `/api/*` and WebSocket upgrades. Use an exact allowlist; no wildcard/bypass policy. The example disables workers.dev and preview URLs. Keep it private until protection is verified; enable only the intended protected hostname afterward. Never leave an alternate unprotected URL.

### 2. Configure the GitHub App

Install an App on selected repositories only. Required repository permissions:

- Contents: read/write.
- Pull requests: read/write.
- Metadata: read.

Do not grant workflow or unnecessary organization permissions. Configure these Worker secrets using Wrangler's prompts rather than putting values in source:

```sh
pnpm exec wrangler secret put GITHUB_APP_ID --config wrangler.staging.jsonc
pnpm exec wrangler secret put GITHUB_INSTALLATION_ID --config wrangler.staging.jsonc
pnpm exec wrangler secret put GITHUB_PRIVATE_KEY --config wrangler.staging.jsonc
```

The private key must be PKCS#8 PEM; GitHub's downloaded key may require local conversion. Keep all key files out of Git, build contexts, transcripts and guest workspaces. No personal access token is required. Workers AI uses the account's AI binding, not a committed provider API key.

### 3. Build and deploy deliberately

Deployment creates or updates paid cloud resources. Review configuration, permissions, image and costs first.

```sh
pnpm check
pnpm build:staging
pnpm exec wrangler deploy --config dist/multipi_staging/wrangler.json
```

Do not deploy `wrangler.local.jsonc` or anything under `test/`. The default production configuration is separate and has no repository grants or enabled public/preview URLs.

For updates, inspect pending work before replacing existing RoomDO instances or containers. A deployment receipt alone does not prove that existing rooms are running the new code; verify actual behavior. Preserve the exact validated image when doing a Worker-only rollout.

## Room workflow

1. Sign in through Access and create a room with an allowed repository and full base commit SHA.
2. Wait for checkout/checkpoint creation; the owner grants explicit room membership.
3. Submit follow-ups or steer at a tool boundary. Closing a page does not stop work.
4. Inspect actual tool/Host results. Model prose is not proof of a successful command.
5. On an uncertain execution, inspect state and explicitly restore the last acknowledged checkpoint. Unacknowledged changes may be discarded; dependency caches are disposable.
6. Freeze and inspect the exact patch. Publishing requires a separate authenticated human approval of that immutable review; no automatic publication or merge.

Only submits are eligible for scoped outbox replay. Stop, restore, Retry and publication are not automatically replayed after an uncertain reply. A control timeout reports uncertainty; it does not establish server-side cancellation.

## Security and limitations

- Access and exact-origin checks supplement room ACLs; localhost-only fixture auth is not production authentication.
- Worker-owned brokers keep provider/GitHub credentials outside generated-code environments. Guest network access is restricted; this is not an acceptance claim for hostile public multi-tenancy.
- Checkpoint acknowledgement is not exactly-once filesystem or external-effect execution. Unknown outcomes remain recovery-gated.
- Socket authorization uses bounded leases; revocation propagation is not instantaneous.
- Archive fences work/read-only access but does not purge Durable Object history, R2 artifacts, local IndexedDB or external GitHub branches/PRs. Full retention/purge is not implemented; external logout does not erase browser drafts.
- Private packages, arbitrary egress, submodules, Git LFS and non-Linux toolchains are outside the initial supported scope. Unsupported patch types fail closed.
- No sensitive-data or production acceptance is claimed. Review identity, isolation, capacity, billing, retention and licensing before broader use.

Local agent research, hosted acceptance reports, credentials, generated output and private deployment settings are intentionally excluded from this repository. No project license has been selected; dependencies retain their own licenses.
