# UTXO Pizza fork changelog

This log covers additions to the UTXO Pizza fork. The [live application](https://timelock-tool.utxo.pizza/) uses Cloudflare Pages Direct Upload; a GitHub commit and a live deployment are separate events. The npm package version is retained from upstream, so source commits identify the changes below.

## 2026-09-13 — Public backup and recovery

Feature source: [8fff256](https://github.com/utxo-pizza/bitcoin-asset-timelock-tool/commit/8fff2569faa99a757001e05f570d2b63f3d25a2d). The feature and its verification fixes were deployed before publication of this commit.

### Added

- Public recovery JSON containing only format/version, one network and up to 20 outpoints within 4096 UTF-8 bytes. Users can inscribe the file separately through UniSat and retain its inscription ID.
- Restore from the original lock transaction ID, public JSON text/file or backup inscription ID in the matching CSV/CLTV workspace.
- Separate recovered-reference storage, raw-transaction and lock-script matching, explicit per-record verification, and a reviewed unlock using the original owner wallet.
- Verification of current outputs/assets, fee inputs and maturity, exact signed-transaction checks, and a saved attempt ID before broadcast for checking uncertain submissions.
- A dedicated recovery browser harness and public format/operating documentation.

### Fixed

- Fractal confirmation checks no longer require a reported confirmation count to equal a formula using a separately fetched chain tip. Matching confirmed transaction/output heights and a positive count are still required.
- Runes/BRC-20 indexes need to cover the particular output's confirmed creation height, rather than an unrelated latest chain tip. Current unspent state and asset completeness are checked separately; fee inputs also require per-output Runes coverage.

These fixes retain the original lock condition: a recovered CLTV reference with an unmet target remains disabled until Chain MTP is strictly after that target.

### Verified and documented

The feature publication passed 105 local Node tests, strict TypeScript and documentation checks. The deployed code passed a production build and 23 recovery browser scenarios after the fixes; the original 36 browser scenarios had passed earlier. The maintainer subsequently confirmed that the reported disabled-review problem for imported Fractal CLTV references was resolved. Transaction confirmation and final token-balance evidence were not supplied with that report.

The documentation follow-up synchronizes the README and validation status with that retest, documents the Import → Verify → Review steps and disabled-button reasons, and makes these fork changes discoverable from the documentation guide. See [validation evidence](VALIDATION.md) and the [recovery guide](PUBLIC-BACKUP.md).

## 2026-09-11 — CSV/CLTV fork publication

Source: [5cea33d](https://github.com/utxo-pizza/bitcoin-asset-timelock-tool/commit/5cea33d5dabcf0b1ae7ad37acab16790462ecb22).

- Added fixed UTC-date CLTV locks using BATL v2 while preserving CSV scripts and BATL v1. CSV remains limited to 65,535 relative blocks; CLTV uses an absolute timestamp.
- Separated CSV and CLTV pages, drafts, records and input fields, with Chain MTP-based CLTV date handling and strict maturity checks.
- Added a per-attempt `Test Unlock (skip MTP)` action for original local CLTV records. It preserves the original script and transaction condition; recovered references added later do not expose this action.
- Published UTXO Pizza site/repository links, development and deployment guidance, validation notes and synthetic regressions, while retaining upstream attribution and the MIT license.

The maintainer reported successful CSV tests and a Fractal BRC-20 premature CLTV attempt returning `non-final` through the wallet broadcast path. The initial fork-publication baseline had 44 local Node tests and 36 browser scenarios; the [validation record](VALIDATION.md) explains their scope.
