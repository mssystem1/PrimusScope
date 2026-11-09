# PrimusScope — consolidated environment checklist

Current review: 9 November 2026, Europe/Samara. Product scope is the full Primus ecosystem: Finance, zkTLS Network, Task/Proof Explorer, Developer Studio and Wallet Workspace. BSC Finance is the first source slice.

**Current runtime update:** public Internet access is now unrestricted/enforced, the Etherscan binding remains ready, and keyless BSC/Base public RPC trials succeeded. No further environment change or API key is required for the demonstrated data reads. See [live data readiness](docs/discovery/DATA_READINESS.md).

This separates the development environment from future deployment configuration. It is a checklist, not a claim that uncreated services or untested providers are ready. No configuration or publication action was performed to create this document.

## One development configuration pass

### Network — recommended development option

In **Edit environment → Public Internet access**, enable **Allow access to all public Internet resources** (`Разрешить доступ ко всем ресурсам общедоступного интернета`). Keep package-manager access enabled and preserve existing domain entries.

This gives development tools outbound access to the public documentation, RPC/API providers, SDK assets, browser downloads and Vercel previews needed as the project develops. It avoids asking for another environment edit for every public hostname. It does not publish the application or the environment.

Keep the existing HTTP secret's credential destination restricted to **`api.etherscan.io`**. Broader network access must not broaden the credential binding. Do not change secret destinations to a wildcard.

If restricted networking is preferred instead, use a consolidated allowlist; a complete future list cannot be guaranteed before choosing deployment providers and SDK modes. Known relevant hosts are:

```text
primuslabs.xyz
*.primuslabs.xyz
*.padolabs.org
api.etherscan.io
docs.etherscan.io
bscscan.com
basescan.org
*.publicnode.com
mainnet.base.org
cdn.playwright.dev
playwright.download.prss.microsoft.com
vercel.com
api.vercel.com
*.vercel.app
```

Preserve the package-manager preset and existing custom entries. Database/worker provider domains would still need adding once chosen. Allowlisting a source permits testing it; it does not prove free access, completeness or uptime. The unrestricted development option avoids that continuing domain-list maintenance.

### Current required variable

| Name | Current state | Purpose |
| --- | --- | --- |
| `ETHERSCAN_API_KEY` | **Already configured and ready**; actual BSC source requests succeeded | Server-side Etherscan V2 reads; credential stays scoped to `api.etherscan.io` |

Do not re-enter this key if the existing binding is present. Do not paste it into chat, source files or `.env.example`. The discovery scripts read the process environment; `.env.example` is a template and does not populate Codex settings.

No additional secret is currently required. Optional public RPC endpoint overrides such as `BNB_RPC_URL` or `BASE_RPC_URL` are configuration choices, not necessarily paid keys. Public candidate endpoints can be recorded in the reviewed source registry without requiring manual environment-variable edits for every chain. They still require actual capability validation.

### Repository and tooling

Keep the existing `mssystem1/PrimusScope` checkout and current setup conversation. Do not create replacement environments merely to edit settings. Existing platform Git authentication is used; a new GitHub token is not a default requirement.

The first application framework is now implemented with Node 24, npm workspaces and Next.js. Dependencies are pinned in `package-lock.json`; a public recorded-data build requires no database or additional credentials. The agent handles package installation and application checks. See [README.md](README.md) and [docs/TESTING.md](docs/TESTING.md) for run commands and their limits.

Current local commands from the repository root are:

```sh
npm ci --cache .local/npm-cache
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Use `npm run dev` for development and `npm run start` after a production build. The workspace cache avoids permissions problems with the default npm cache. These are repository instructions; no environment configuration was reapplied or published. A future reusable setup can use these commands after review, without another source-discovery pass.

Optional local indexing now uses Node's built-in SQLite support. The
`indexer:init`, `indexer:once`, `indexer:status`, `dev:indexed` and
`start:indexed` scripts manage local collection/serving without editing the
managed environment. See [LOCAL_INDEXER.md](docs/LOCAL_INDEXER.md). These commands
do not provision hosted storage or a persistent cloud worker; those remain part
of the later consolidated deployment setup.

Browser TLS verification stays enabled. Browser trust/configuration problems are tooling issues to resolve through supported scoped mechanisms, not a reason to request blanket certificate-error bypasses from the user.

## One separate launch configuration batch

**Hosted batch now configured:** Neon Free stores the durable publication;
`primus-scope` receives only `WEB_DATABASE_URL` and `PRIMUSSCOPE_DATA_MODE=hosted`;
`primus-scope-collector` receives only `WORKER_DATABASE_URL` and `CRON_SECRET`.
These are encrypted Vercel production settings, not new Codex settings to enter
or publish. Provider administrative connection variables were disconnected from
the web project after bootstrap. See [HOSTED_INDEXER.md](docs/HOSTED_INDEXER.md).
The table below describes ownership boundaries; no further credential entry is
required for these deployed public workflows.

These values cannot be supplied before the database, worker service and Vercel project exist. They are not prerequisites for current source discovery or local development. Provisioning/selection should be completed together and the resulting configuration reviewed as one launch batch.

| Configuration | Where it belongs | Why / who supplies it |
| --- | --- | --- |
| `WEB_DATABASE_URL` | Vercel server runtime; integration tests only if needed in Codex | Pooled Postgres connection with access only to approved public serving views |
| `WORKER_DATABASE_URL` | Worker runtime | Scoped ingestion/checkpoint/read-model writes |
| `MIGRATION_DATABASE_URL` | Controlled migration process | Provider-supported schema migration connection; not used by web requests |
| Vercel authentication | Deployment workflow | One supported method: linked/Git integration, interactive CLI, or a scoped token; `VERCEL_TOKEN` only if token automation is chosen |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | CLI/CI when required | Non-secret IDs can be discovered after project linking; no need for manual entry now |
| Production data API credentials | Vercel/worker secure settings, according to which runtime calls the provider | Only selected, validated sources; preserve the $0 data API requirement |
| Worker-host authentication/configuration | Selected worker provider | Only after provider selection; no speculative account/token request now |

Development can use a local disposable Postgres database. Hosted database credentials are needed when hosted integration/deployment work begins. Maintain staging/production separation and least privilege; do not put production credentials into every preview.

Codex, Vercel and the worker have separate secret stores. Saving a Codex HTTP secret does not automatically configure production. A proxy placeholder must not be copied into Vercel as a real key or into a Postgres DSN as a password. Use actual credentials through each platform's supported secure settings; do not expose values in chat or logs. Raw database authentication requires a supported connection path, not merely an HTTP-secret binding.

## Feature-dependent requirements — not upfront setup

- Primus app credentials are needed only if a selected official SDK feature requires registered proof generation/signing. Public chain analytics does not inherently need a Primus app secret. Resolve exact SDK mode first.
- WalletConnect/project IDs apply only if that wallet connector is chosen. Public analytics and public task lookup work without connecting a wallet.
- Monitoring, email/alerts, Redis, payments and other optional services are not initial credential requirements. Introduce them only with a justified feature and batch their settings.
- No wallet private key, seed phrase, decryption viewing key or user permit belongs in the analytics environment.
- No API/database secret may use a browser-exposed `NEXT_PUBLIC_*` name.

## Save/apply versus Publish

Use **Save draft/apply** to request runtime configuration changes, then check observed readiness and make a fresh request. **Publish** is a separate reusable-version/snapshot action; it is not required after every ordinary variable or domain edit. The Etherscan binding is already working in the current runtime.

Do not publish or recreate the environment now merely to follow this checklist. When the reusable installation/start workflow is tested, publication can be handled as one deliberate step. Configuration service errors must be reported; they are not evidence that a save applied.

## Current data limitation is separate from environment setup

Etherscan authentication works. Source/ABI metadata reads succeeded for all four Finance aggregators. The tested BSC `getLogs` and block-data operations returned a free-plan unsupported response for this key. Changing network access cannot change that provider entitlement.

That next source test has now succeeded: PublicNode accepted bounded BSC batch reads and a separate Base task sample without a provider key. Etherscan is retained for supported metadata. No paid upgrade, fake zero activity or full-history readiness claim is enabled. See [live data readiness](docs/discovery/DATA_READINESS.md), [Etherscan capability evidence](docs/discovery/bsc-etherscan-capabilities.json) and [ecosystem scope](docs/planning/12-ecosystem-scope.md).

The workflow commitment is to batch a development setup and a launch setup, rather than request one hostname or optional credential at a time. Exact future values depend on real selected services; they will not be invented in advance.
