# Security policy

This repository is the UTXO Pizza community fork of Bitcoin Asset Time Lock. It constructs transactions that can irreversibly lock or spend assets. It is provided under the [MIT license](LICENSE), without a custody service, recovery guarantee or claim of an independent security audit.

## Report a vulnerability privately

GitHub private vulnerability reporting is enabled for [this repository](https://github.com/utxo-pizza/bitcoin-asset-timelock-tool/security). Use **Security → Report a vulnerability**. Do not assume the feature is enabled on another fork. If no private channel is available, ask the maintainer for one without publishing the technical details of a potentially exploitable issue. No private email address or response-time commitment is published here.

Include the affected commit/deployment, expected and observed behavior, impact, and a minimal local synthetic reproduction or relevant code location. Suggestions for remediation are welcome. Avoid testing the issue against real accounts, live nodes, explorers or production infrastructure; do not move anyone's funds to demonstrate a finding.

Never include seed phrases, private keys, API keys, cookies, browser storage exports, pending signed PSBTs or other broadcast-capable authorization data. Redact unrelated wallet addresses, transactions and personal information. Route issues specific to an upstream dependency through that project's own security process when appropriate.

## Important trust and recovery boundaries

- The browser loads executable JavaScript and depends on its hosting origin, wallet extension, dependencies and configured API services. This application never asks for a seed phrase or private key.
- OpenAPI keys and local records are stored in origin-specific LocalStorage, not encrypted backup storage. Pending BRC-20 records contain signed transactions that can be broadcast; protect them accordingly.
- The same `bc` address prefix does not distinguish Bitcoin from Fractal. Review the wallet's actual network before signing. Configured API endpoints are trusted for chain metadata and asset selection, not independently authenticated as a particular chain by a response string.
- Lock maturity is enforced by transaction/script rules. Web prechecks reduce mistakes but are not the on-chain lock. CLTV test unlock skips only one web precheck after explicit confirmation; it does not modify the original CLTV condition.
- A wallet/API rejection does not establish that every subsequent transaction or asset check would pass. A transaction ID or local `unlocked` status is not confirmation.
- Public recovery files contain only network/outpoint pointers. Their contents, inscription ownership and local cached verification never authorize a spend. Recovery rederives the actual BATL output and requires the original wallet key; never inscribe a storage dump, private key or signed transaction.
- Recovered unlocks check current output/asset data, maturity, wallet identity and the exact signed transaction, accepting only ALL or Taproot DEFAULT signatures. These checks are not an independent consensus or asset-indexer audit. Older local-record unlock flows have not been rewritten to use this new recovery pipeline.
- UniSat can omit some inscriptions from an output's detail array. Recovery requires a valid total count matching the returned details; absent or filtered information remains unknown. Funding checks cover inscriptions and Runes, not every other asset protocol. Use known ordinary fee funds and review every input/output.
- Local record loss, stale UTXOs, reorganizations, external spends and partial broadcasts still require care. Public recovery does not restore pending signed BRC-20 chains, private keys, or missing historical services. Read the [backup boundaries](docs/PUBLIC-BACKUP.md).
- Do not add unrelated asset-bearing inputs as fee funding. A Rune pointer does not protect every other asset protocol.

## Validation and supported versions

Read the [validation matrix](docs/VALIDATION.md) for the exact evidence available. Maintainer-reported CSV success and a Fractal CLTV `non-final` result are not a blanket audit or compatibility guarantee. No security-support schedule or long-term release policy has been published; include the exact revision when reporting a problem.

This policy does not authorize active security testing of the live site, public networks or third-party services.
