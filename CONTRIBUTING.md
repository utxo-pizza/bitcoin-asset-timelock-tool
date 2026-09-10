# Contributing to the UTXO Pizza fork

Start with the [README](README.md) and [development guide](docs/DEVELOPMENT.md). Preserve the [upstream project's](https://github.com/unisat-wallet/bitcoin-asset-timelock-tool) attribution and original MIT notice.

## Before proposing a change

- Check whether the issue is specific to this fork, a wallet/API integration, or upstream behavior. State the affected source commit or deployment identifier.
- Describe observed and expected results, selected chain and asset family. Use synthetic fixtures or public, non-sensitive examples.
- Never post a seed phrase, private key, API key, browser storage export, pending signed PSBT or broadcast-capable transaction in an issue or PR. Screenshots can also expose account and transaction history.
- Follow [SECURITY.md](SECURITY.md) for potentially exploitable findings. Do not test suspected vulnerabilities against public nodes, wallets, explorers or the live site.

## Develop and verify

Keep changes focused and use the existing TypeScript stack and lockfile. Run:

```bash
npm ci
npm test
npm run docs:check
npm run build
```

For UI, state or wallet-orchestration changes, also run the [local browser harness](docs/DEVELOPMENT.md#browser-integration-tests). It uses a loopback preview and synthetic wallet/API responses, not live funds. Report exactly which checks you ran and any skipped checks; a build alone does not validate chain consensus or token balances.

Add a regression test for non-trivial behavior changes. Changes to transaction construction, recovery formats, funds, signing, permissions or persistence need independent review of the actual diff before release. Do not weaken a failing assertion merely to make a test green.

## Compatibility boundaries

- Preserve existing CSV addresses, tapscripts, control blocks and BATL v1 bytes. Changing a label must not reinterpret a stored lock.
- Keep CSV and CLTV inputs, transaction fields, BATL versions and local record schema versions distinct.
- Never move the Rune edict destination or change pointer/output relationships without a deliberate protocol and asset-allocation review.
- Preserve principal-return and separate-fee-input behavior on unlock.
- Do not rebuild a pending BRC-20 signed chain with a new target or outpoint. Preserve partial progress on failure.
- Keep identity and record checks across asynchronous wallet calls. Multiple browser tabs are not transactionally isolated.
- Treat Chain MTP, endpoint identity and asset-indexer responses as explicit trust boundaries; do not substitute the computer clock.

See the [BATL contract](docs/BATL-PROTOCOL.md) and [architecture](docs/ARCHITECTURE.md) for details.

## Documentation and release preparation

Update usage, protocol and validation documentation whenever behavior changes. Separate reproducible repository tests, maintainer-reported external checks and outstanding acceptance work. Do not claim an audit or blanket network support from a successful synthetic test.

Before publication, inspect the complete proposed commit—including new files—for secrets, personal data, generated artifacts and machine-specific paths. Check dependencies and license notices separately. `docs:check` validates local documentation links; it is not a secret scanner or security audit.

Forks should use their own repository and site links while retaining upstream attribution and legal notices. CI checks source; it does not publish to Cloudflare. GitHub Pages deployment is an explicit, optional manual workflow described in [deployment](docs/DEPLOYMENT.md).
