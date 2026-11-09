# Vercel observation release

Public application: **https://primus-scope.vercel.app**. The Vercel project is
`primus-scope`, connected to `mssystem1/PrimusScope`, production branch `main`.

The first hosted release serves the bundled, sanitized recorded observations.
Its UI identifies this mode and its exact coverage. The local SQLite worker is
a separate tested component; this deployment does not run it continuously or
use ephemeral Vercel files as a database.

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
- Serving mode: `PRIMUSSCOPE_DATA_MODE=recorded`.

No Etherscan, RPC, database or wallet credential is required for this recorded
release. Authentication for deployment belongs to the Vercel CLI/account, never
the browser bundle or repository. Local authentication, linking and build files
are ignored by Git and excluded from upload. The worker and discovery evidence
are excluded from server-function tracing.

## Release and validation

Commit the reviewed code before deployment. Check the local production build,
TypeScript and relevant test suites, then deploy that commit. GitHub Actions
repeats the recorded/indexed checks on the main branch.

After deployment, run the recorded-mode browser/API suite against its real URL:

```sh
E2E_BASE_URL=https://your-deployment.vercel.app npm run test:e2e
```

Inspect desktop and phone screenshots as well as automated accessibility
results. Confirm asset loading, API headers, task/batch lookup, saved views,
developer requests, source disclosure, pagination, invalid inputs and CSV
reconciliation. Local indexed fixture tests do not apply to a remote recorded
deployment and must keep using their isolated local database.

Record the deployed commit, URL and observed results. A ready deployment or
successful homepage request alone does not establish workflow correctness.

## Hosted indexing gate

An external durable database adapter, worker scheduling/hosting, retention,
backup/restore and production recovery checks are required before indexed
serving can replace the recorded release. Configure those services in one
separate batch; never upload the local SQLite file as a production datastore.
