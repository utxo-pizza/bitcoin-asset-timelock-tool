# Development and tests

This fork is a static React/TypeScript application: there is no project-owned backend, database, node daemon or scheduled unlock service. Start with the [README](../README.md) for the user-facing flow; use [BATL](BATL-PROTOCOL.md) when changing wire formats.

## Prerequisites and setup

The package declares Node.js `^20.19.0 || >=22.12.0`. The current validation environment uses Node.js 24; CI uses Node.js 24 as well. Use the committed `package-lock.json` rather than resolving a fresh dependency tree.

The package version is retained from upstream; a source commit identifies this fork's current development snapshot. Historical upstream tags do not identify the new CLTV changes. `private: true` prevents accidental npm package publication; it does not make the GitHub repository or MIT-licensed source private.

```bash
git clone https://github.com/utxo-pizza/bitcoin-asset-timelock-tool.git
cd bitcoin-asset-timelock-tool
npm ci
npm run dev -- --host 127.0.0.1
```

The default `dev` and `preview` scripts bind `0.0.0.0`; override the host on shared machines. Use UniSat in your own browser only when deliberately testing a real wallet. Automated tests need no real API key, wallet or funds.

## Commands

| Command | What it establishes |
| --- | --- |
| `npm test` | Local synthetic transaction, protocol, date, API, record and workspace regressions |
| `npm run docs:check` | Local Markdown link targets and supported heading fragments exist |
| `npm run build` | TypeScript application/config checks and a Vite static build in `dist/` |
| `npm run preview -- --host 127.0.0.1` | Local serving of that build; not a production server |
| `npm run test:ui` | Optional browser integration harness after building; requires Playwright and Chromium |

To type-check the test harness and documentation checker explicitly:

```bash
npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --skipLibCheck --esModuleInterop --allowSyntheticDefaultImports --jsx react-jsx --types node,vite/client tests/records-date-api.test.ts tests/browser/local-ui.ts scripts/check-docs.ts
```

Vite currently reports dependency `stream`/`events` externalization and a large JavaScript chunk. Record warnings honestly; do not equate a successful bundle with wallet, consensus or asset-indexer acceptance.

## Browser integration tests

The harness starts its own loopback preview, creates isolated browser contexts, mocks UniSat and OpenAPI, and blocks unexpected off-origin traffic. It does not obtain real wallet credentials, sign real transactions or broadcast to a network. It writes ignored screenshots to `.ui-artifacts/` and closes its browser/preview when finished.

Playwright is optional and is not part of the project's locked dependencies. The recorded browser run used Playwright 1.63.0 and Chromium. One setup for a disposable development environment is:

```bash
npm install --no-save --package-lock=false playwright@1.63.0
npx playwright install chromium
npm run build
PLAYWRIGHT_MODULE=playwright npm run test:ui
```

These installation commands download browser tooling; they are not run by `npm test` or by the harness itself. On Linux, review Playwright's [browser and system-dependency guidance](https://playwright.dev/docs/browsers) before installing OS packages. Do not reconfigure a production machine merely to run a browser test.

Alternatively, use an existing installation:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chrome-headless-shell \
npm run test:ui
```

The Unix-style environment syntax above can be adapted to your shell. `UI_SCENARIO_FILTER` selects scenario names containing a substring; omit it for full coverage. A filtered run is not a full-suite pass.

## Configuration and secrets

Endpoint overrides in [.env.example](../.env.example) are optional; built-in endpoints work without an `.env` file. Overrides are public build-time configuration and must still point to the intended network. All `VITE_*` values referenced by frontend code are public in the bundle—never put a token, password or private key in them.

Enter the OpenAPI key in Wallet Setup. It is stored locally for convenience, not injected at build time. Do not commit `.env` files, credentials, signed PSBTs, browser-profile data or storage backups. Changing an API key invalidates the CLTV MTP preview; use `Refresh Chain Time` afterward.

`VITE_BASE_PATH` defaults to `./` in the Vite configuration and can be supplied to the build process for hosting; see [deployment](DEPLOYMENT.md#build-and-base-path).

## Source map for contributors

| Area | Main implementation |
| --- | --- |
| Wallet operations, confirmations, identity snapshots and broadcast orchestration | [App](../src/App.tsx), [wallet adapter](../src/lib/wallet.ts) |
| Separate pages, drafts and fields | [workspace hook](../src/hooks/useLockWorkspaces.ts), [operation panel](../src/components/OperationPanel.tsx), [lock fields](../src/components/LockFields.tsx) |
| Lock conditions, UTC parsing and transaction construction | [conditions](../src/lib/lock-condition.ts), [dates](../src/lib/lock-date.ts), [transactions](../src/lib/timelock.ts) |
| BATL and Runestone encoding | [recovery primitives](../src/lib/recovery.ts), [Runestone](../src/lib/runestone.ts) |
| Namespace validation and guarded record writes | [records](../src/lib/records.ts) |
| Chain/asset endpoints and MTP snapshots | [OpenAPI](../src/lib/openapi.ts) |
| Synthetic regression fixtures | [core tests](../tests/core.test.ts), [record/date/API tests](../tests/records-date-api.test.ts), [browser harness](../tests/browser/local-ui.ts) |

Do not reinterpret a record's schema version as a BATL version. Keep the [architecture guide](ARCHITECTURE.md) and [validation record](VALIDATION.md) aligned with changes. The source tree contains no production keys or real-wallet fixture requirement.
