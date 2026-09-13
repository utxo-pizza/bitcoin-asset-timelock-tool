# Validation evidence and limits

This document separates executable repository tests from historical checks and maintainer-reported real-world results. It is not a security audit, custody guarantee or blanket compatibility matrix. Last documentation review: **2026-09-13**.

## What is covered

| Area | Evidence available | What it does not establish |
| --- | --- | --- |
| CSV | Maintainer reports that their CSV tests passed; frozen CSV script/address/BATL/PSBT fixtures also pass locally | The report does not enumerate every network/asset combination or constitute an independent audit |
| CLTV construction and boundaries | Local tests cover timestamp ranges, 2038+, minimal ScriptNum, nLockTime/sequence, principal and fees | Real wallet and indexer support on every available chain |
| Storage, MTP and operation orchestration | Local tests cover malformed data, separate namespaces, strict MTP comparison, identity changes and workspace isolation | Transactional isolation across tabs or continuous chain monitoring |
| Public backup and recovered unlock | Synthetic tests cover strict public files, raw output matching, owner parity, per-output indexer-height coverage, complete indexed asset inventories, bounded API reads, signature verification and persistent attempt IDs | Real inscription-service acceptance, a lost-record recovery on live networks, or trustless asset verification |
| Browser behavior | 36 original scenarios plus 23 recovery scenarios passed at the recovery-feature verification snapshot, including mobile confirmation and locally signed synthetic unlocks | A real wallet, live API authorization or actual asset settlement |
| Historical Bitcoin Core regtest and ord | Isolated signed CLTV spends rejected before/equal MTP and accepted after; synthetic Rune allocation and return checked | Fractal mainnet consensus deployment or BRC-20 balance-indexer acceptance |
| Fractal CLTV premature attempt | User-operated BRC-20 test returned `non-final` at wallet broadcast after skipping the web precheck; original lock output matched the CLTV template | An independently captured node RPC response, successful mature unlock, balance reconciliation or live Runes acceptance |

The local Node suite had **105 passing tests** at the latest recovery verification on 2026-09-13; application/test strict TypeScript checks, a production build and the 23-scenario recovery browser harness passed. The original 36-scenario browser harness passed before this confirmation-count-only fix and is unaffected by that recovery-only code path. The earlier publication baseline had 44 Node tests and 36 browser scenarios. Counts describe actual runs, not a fixed specification; use current command output after changing tests. These are local source checks, not evidence that a backup was inscribed or an unlock accepted. Independent engineering review is not an external security certification.

## Reproduce the repository checks

```bash
npm ci
npm test
npm run docs:check
npm run build
```

For both browser suites, follow the [Playwright setup](DEVELOPMENT.md#browser-integration-tests). The checked-in tests use fixed synthetic wallet identities, public keys, API-key placeholders and transaction fixtures solely for local testing. The recovery harness performs cryptographic signing only with a deliberately known test key and intercepts broadcasts locally. Never send funds to fixture addresses or use placeholder credentials in production. These are mock wallet providers, not acceptance tests of a live wallet or chain.

The historical full-node experiment used Bitcoin Core 31.1 and ord 0.29.0 on isolated regtest with zero peers. Its harness and large node/indexer artifacts are not distributed in this repository and are **not** rerun by `npm test`. These are retained as maintainer-recorded historical observations, not a fresh reproducible test supplied by the public tree. BRC-20 was checked there only for the five-transaction inscription shape, not for token balances.

## Interpreting the Fractal result

The real test was initiated by the user, not by the local synthetic harness. The reported result was `CLTV test — wallet broadcast: Error: non-final`. The original BRC-20 output was confirmed and its raw transaction ID, BATL v2 parameters and derived CLTV output were matched during a public read-only check. Wallet-linked transaction identifiers and balances are omitted from the public notes for privacy.

In the [Fractal implementation](https://github.com/fractal-bitcoin/fractal/blob/8c22167f04250c7dd03afe46af4158bd08001183/src/validation.cpp#L737), the mempool finality precheck returns `non-final` when the transaction's absolute lock is not yet satisfied. Time-based checks use tip MTP and strict `nLockTime < MTP`. That check precedes full script/signature validation; the error alone does not prove those later checks would succeed.

The strongest supported conclusion is: **the reported real premature unlock attempt was rejected through the wallet broadcast path, not by this website's MTP precheck**. The exact signed transaction, test-time MTP and independent node logs were not captured for that attempt. Do not restate it as proof that every possible transaction variant or every asset flow has been tested.

## Outstanding acceptance

The recovery feature was deployed to the linked live application on 2026-09-13. Five published files matched the release manifest byte-for-byte; headers/cache policy and anonymous CSV/CLTV mobile entry checks also passed. This deployment evidence does not establish real wallet, inscription, indexer or mature-unlock acceptance. The exact dirty-source build is identified by the live [release descriptor](https://timelock-tool.utxo.pizza/release.json).

- CLTV: user-confirmed unlock after MTP is strictly later than the target, followed by transaction confirmation and BRC-20 balance reconciliation.
- Explicitly recorded live network/asset coverage, including Runes, before publishing a wider compatibility claim.
- User-operated public-file inscription, subsequent recovery by inscription ID after local-record loss, and a confirmed mature recovered unlock with asset reconciliation.
- Third-party recovery-format/BATL v2 interoperability and network-specific indexer availability, including complete inscription counts. Missing or filtered indexer data must remain unknown.

Any further real transaction should be deliberately initiated and checked by its owner. Do not run automated premature-broadcast loops or active security tests against live infrastructure. Use the normal protected unlock flow for the eventual mature transaction.
