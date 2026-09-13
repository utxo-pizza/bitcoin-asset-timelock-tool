# Public backup and recovery

> This feature was deployed to the [live app](https://timelock-tool.utxo.pizza/) on 2026-09-13. Deployment and local synthetic verification do not replace user-operated live-wallet, inscription and mature-unlock acceptance testing.

A public backup is an index of existing locks, not a private-key backup or an authorization to spend. The original BATL data already lives in the lock transaction. A separate inscription preserves a convenient directory of those transaction outputs.

## Make the backup

1. Open the original CSV or CLTV workspace and select the correct recovery network.
2. Select the public references to include, inspect the JSON preview, and download it. Files contain at most 20 outpoints on one network. Pending BRC-20 chains and their signed PSBTs are excluded.
3. Check the original lock's confirmation and asset state before paying for another inscription. A local “locked” label or a recovered reference is not that proof.
4. Personally upload the file using the file-inscription workflow on [UniSat for Bitcoin](https://unisat.io/inscribe) or [UniSat for Fractal](https://fractal.unisat.io/inscribe). Use the same network named in the file, your own receiving address for easier discovery, and ordinary BTC/FB for fees. Review the external site's order and wallet transaction yourself. Test networks require an appropriate service/network selection; the app does not guess an inscription-service URL.
5. Wait for the inscription to confirm and separately retain its inscription ID, original lock IDs, and a copy of the JSON. Import the backup to check that its references can be recovered.

The application only generates the file and reads recovery data. It does not create, pay for, monitor, or automatically broadcast an inscription order. **A download is not an on-chain backup.** The backup inscription's confirmation does not establish that its referenced locks contain valid assets.

## Recover after local data loss

Configure an OpenAPI key, select the original network and open the matching CSV/CLTV workspace. Restore using one of:

- The original managed lock transaction ID: the fifth BRC-20 transaction, or the Rune deposit transaction.
- The public JSON text/file.
- The ID of an inscription containing that public JSON.

The app exports and imports one lock workspace at a time. A mixed CSV/CLTV directory must be split into separate files; importing it does not silently save only a subset. Existing original records are not duplicated or migrated.

The app recomputes the raw transaction ID, decodes a unique supported BATL marker and matches the actual lock script/output. It saves a separate public reference, not a fabricated copy of the old application record. Initial imports do not assert that assets are valid or spendable. Use the explicit verification action to query current output and asset data.

To unlock, connect the original key/account, address type and network, then review the recovered unlock after maturity. The principal returns to the owner's first output, and separately verified inputs cover the fee. The confirmation lists transaction details and requires checking that fee funds contain no assets from other protocols.

A saved unlock-attempt ID is not confirmation. If broadcasting fails or its result is uncertain, inspect that transaction before explicitly reviewing a retry. There is no automatic retry or maturity-bypass entry in the recovery flow.

## Public file format

The format is specific to this recovery feature. It does not change BATL scripts or the BATL v1/v2 wire formats.

| Field | Contract |
| --- | --- |
| `format` | Exactly `batl-recovery` |
| `version` | Exactly `1`; the file version, not the lock type |
| `chain` | One supported `ChainType` |
| `outpoints` | 1–20 unique objects containing only `txid` and `vout` |
| `txid` | 64 hexadecimal characters, normalized to lower case |
| `vout` | Integer from 0 through 4,294,967,295 |

The entire UTF-8 JSON is limited to **4096 bytes**. Extra fields are rejected, including addresses, amounts, API keys, private keys and signed PSBTs. Public export reconstructs this whitelist; it never serializes full local records. Inscription contents are bounded inert data, not HTML, remote URLs to execute, or a source of transaction instructions. The implementation is in [recovery-manifest.ts](../src/lib/recovery-manifest.ts).

## Verification and trust boundaries

- The original script requires its owner's valid signature and the original CSV/CLTV condition. Copying or owning the backup inscription does not grant that key or change the lock. Anyone may relay an already signed transaction, but the recovered-unlock guard accepts only signatures committing to all inputs and outputs.
- Wallet ownership is checked against the BATL x-only key and derived address. P2WPKH parity/address type matters; a P2TR x-only key does not reveal the original compressed-key prefix. Use the matching account/address derivation.
- Raw transaction hashes and scripts are checked locally. Confirmation, unspent status and asset validity still rely on the selected APIs/indexers, not an independently operated full node. Network names and address prefixes alone do not authenticate a chain.
- UniSat can filter some inscriptions from an output's detail array. As a conservative recovery rule, the app requires a non-negative integer total count matching the array; missing, filtered or inconsistent information is unknown, not permission to spend. This is an application completeness requirement, not a claim that the count is mandatory in every API response. See [UniSat's UTXO response notes](https://github.com/unisat-wallet/unisat-dev-docs/blob/472aa67003261abdb343d930178b075f0b9c4e14/open-api/note-source/blockchain-indexer/getUtxoByTxIdAndIndex.md).
- BRC-20 recovery needs a unique valid transfer inscription in the supported final-output template. Rune recovery preserves every reported balance at the lock outpoint. Unknown, unconfirmed, stale, filtered or mixed asset information blocks recovered spending.
- An asset indexer may lag the current chain tip while still covering an older lock. The app requires its reported indexed height to reach the specific output's confirmed creation height; anything below that height remains unknown. Current unspent state is checked separately against the blockchain index.
- Fee checks cover inscriptions and Runes only. They do not establish the absence of Alkanes or every other protocol. The user must supply known ordinary fee funds.
- Fractal BRC-20 ticker rules differ from Bitcoin's; this feature handles Fractal's 6–12-character names separately and does not substitute Bitcoin's BRC20-Prog semantics. See [UniSat's Fractal explanation](https://docs.unisat.io/welcome/unisat-work-priorities/overview-of-unisat-2025-work-priorities).
- Restored references use their own LocalStorage namespace. Corrupt data is preserved, but LocalStorage remains non-transactional across tabs. Do not operate one lock from multiple tabs.

## What this cannot restore

The file cannot restore private keys, seed phrases, API credentials, original creation times, an unfinished five-transaction BRC-20 chain, or its lost signed transactions. It is not a general arbitrary-Ordinals recovery tool or an automatic wallet-wide lock search. Old local-record unlock paths remain separate from the new recovery checks.

An inscription provides historical on-chain data, not an unconditional promise of perpetual service availability. You still need the backup/lock identifiers, access to transaction history and working compatible tools/indexers. Moving or losing the backup NFT does not transfer the original lock's spending authority; losing the original private key is not repaired by a public backup.

Use small amounts and inspect [validation evidence and remaining live acceptance work](VALIDATION.md). No blanket security, chain-support or recovery guarantee is claimed.
