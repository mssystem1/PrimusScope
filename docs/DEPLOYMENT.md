# Vercel observation release

Public application: **https://primus-scope.vercel.app**. The Vercel project is
`primus-scope`, connected to `mssystem1/PrimusScope`, production branch `main`.

The release supports hosted PostgreSQL observations and a separate scheduled
collector, alongside the default recorded mode used in local fixtures. No
deployment uses ephemeral Vercel files as a durable database. Exact coverage,
collection times and remaining backlog stay visible in Sources.

## Project configuration

Import `mssystem1/PrimusScope` with production branch `main` and Root Directory
`apps/web`. Include repository source outside that directory: shared workspace
packages and the recorded artifact are required during the build.

Use Node 24 and the settings in `apps/web/vercel.json`:

- Framework: Next.js.
- Install: `npm ci --include=dev --workspaces --include-workspace-root`, using the
  repository workspace lockfile and root TypeScript/build dependencies.
- Build: `npm run build` in the web workspace.
- Output: `.next`.
- Production serving: `PRIMUSSCOPE_DATA_MODE=hosted` and read-only `WEB_DATABASE_URL`.

No Etherscan, RPC or wallet credential is required by the public web app. Its
public-data database role can only read the serving publication. The SDK tools
pilot adds separate server-only `DIAGNOSTICS_DATABASE_URL` and
`DIAGNOSTICS_RATE_LIMIT_SECRET` variables on the web project. Its restricted
diagnostics role has function access only, with no public-index permissions.
See [SDK_TOOLS.md](SDK_TOOLS.md) for the API, privacy boundaries and retention.
Authentication for deployment belongs to the Vercel CLI/account, never
the browser bundle or repository. Local authentication, linking and build files
are ignored by Git and excluded from upload. The worker and discovery evidence
are excluded from server-function tracing.

## Release and validation

Commit the reviewed code before deployment. Check the local production build,
TypeScript and relevant test suites, then deploy that commit. GitHub Actions
repeats the recorded/indexed checks on the main branch.

After hosted deployment and an authorized collector invocation, run:

```sh
E2E_DATA_MODE=hosted E2E_BASE_URL=https://primus-scope.vercel.app npm run test:e2e
```

Inspect desktop and phone screenshots as well as automated accessibility
results. Confirm asset loading, API headers, task/batch lookup, saved views,
developer requests, source disclosure, pagination, invalid inputs and CSV
reconciliation. Local indexed fixture tests do not apply to a remote recorded
deployment and must keep using their isolated local database.

Record the deployed commit, URL and observed results. A ready deployment or
successful homepage request alone does not establish workflow correctness.

## Collector project

`primus-scope-collector` uses Root Directory `apps/collector`, Node 24 and the
same workspace install command. Its production-only settings are
`WORKER_DATABASE_URL` and `CRON_SECRET`. Vercel Cron calls `/api/collect` every
15 minutes; the function limit is 300 seconds. The web project receives neither
credential. Both projects are connected to the repository's main branch.
The worker role also has permission to prune expired SDK diagnostic metadata;
this separate retention task runs after chain collection and reports its status
in `X-PrimusScope-Diagnostics-Retention`.

See [HOSTED_INDEXER.md](HOSTED_INDEXER.md) for provisioning, permissions,
publication fencing, restart behavior and operational limits. Scheduling does
not establish caught-up history or an SLA. Capacity/retention and a provider
backup/restore rehearsal remain required before expanding history substantially.
