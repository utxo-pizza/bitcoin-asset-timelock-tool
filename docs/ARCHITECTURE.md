# Architecture and recovery boundaries

The application coordinates a browser, UniSat, the selected chain and asset indexers. It does not operate a backend, hold private keys or automatically unlock assets. Start with the [README](../README.md) for usage and [BATL](BATL-PROTOCOL.md) for exact recovery bytes.

## Responsibilities

```text
Browser: choose asset/condition → build transaction → request wallet approval
   │                                  │
   ├─ OpenAPI: chain MTP, balances, UTXOs and fees
   ├─ LocalStorage: API key, records, public references, pending signed BRC-20 chain
   └─ UniSat: sign → submit to its broadcast service
                         │
                         └─ Chain validation + asset indexing decide the result
```

The browser's prechecks and local labels are not the chain's consensus or asset state. APIs are trusted for the configured network; a response's optional `chain` string is not an independent network proof. Users review the actual wallet network, transaction and outputs before signing.

## Independent workspaces, shared execution

`#/csv` shows relative-block inputs and CSV records. `#/cltv` shows fixed UTC inputs, MTP and CLTV records. Empty or unknown fragments resolve to CSV. Each workspace owns its in-memory asset selection, amount, lock parameters, manual fee override and result. Changing pages does not migrate records; reloading discards unsaved drafts.

A shared operation gate prevents overlapping create/resume/unlock and recovery operations in one tab. Navigation, direct fragment changes and browser back/forward cannot switch workspaces during confirmation, signing or broadcasting. Wallet provider, account, public key, network, API configuration and saved-record identity are checked across asynchronous boundaries. This is not a lock across multiple browser tabs.

## Lock conditions

| Condition | Output script | Unlock transaction |
| --- | --- | --- |
| CSV: integer 1–65,535 blocks | CSV check, drop, owner signature | Version 2, locktime 0, locked input sequence = blocks |
| CLTV: Unix seconds | CLTV check, drop, owner signature | Version 2, locktime = original timestamp, locked input sequence = `0xfffffffe` |

Both use one Taproot leaf and the fixed NUMS internal point specified by BATL. Its private key is not known; the intended spend path is the committed script plus the owner's signature. BATL public metadata is not the enforcement mechanism.

CLTV input is interpreted as UTC, not browser-local time. Creating a new lock requires `target > fresh MTP`; normal unlocking requires `MTP > target`. Equal values fail both respective future/maturity checks. Chain snapshots are bound to a selected endpoint/network with a 60-second validity window and a 15-second request timeout. The device clock only helps detect snapshot staleness, not maturity.

The untouched CLTV date field starts at MTP as a reference; it adds no default duration. User edits, clearing and invalid text are preserved across MTP refreshes. New deposits reject the last two representable uint32 timestamps; raw recovery and existing records preserve them without calling them mature. [BATL's timestamp rules](BATL-PROTOCOL.md#94-creation-maturity-and-spending) explain the boundary.

`Test Unlock (skip MTP)` on original local CLTV records adds a one-attempt confirmation before bypassing only the web precheck. It does not persist a flag, change the script/PSBT or bypass identity checks. Recovered references always use the protected maturity check. The test action may actually unlock an already-mature output. See [validation](VALIDATION.md#interpreting-the-fractal-result) for how to interpret errors.

## How assets enter the lock

### BRC-20

```text
1. Self-transfer commit
   → 2. Self-transfer reveal
   → 3. Send transfer to time-lock address
   → 4. Time-lock transfer commit
   → 5. Time-lock transfer reveal: managed inscription at vout 0 (546 sats)
```

The five transactions are built and signed before any broadcast. Their complete signed chain is saved locally first, then each transaction is submitted in order and progress is saved. A failure can leave a partially submitted chain; it is not atomic. Resume uses those exact signed PSBTs and target. It does not rebuild a date that has passed.

A pending BRC-20 chain blocks another BRC-20 creation for the same account/network across both pages. Record identity refers to the final reveal's output, not another UTXO at the same address. This flow is specifically transfer-inscription handling, not generic NFT locking or proof of BRC-20 indexer acceptance.

### Runes

One transaction can combine sufficient Rune source UTXOs. The app chooses a sufficient smallest single input if available, otherwise combines by indexed Rune balance. The user enters integer base units; indexed divisibility does not automatically convert a display amount.

| Output | Current web app |
| --- | --- |
| 0 | Only OP_RETURN: Runestone plus BATL metadata |
| 1 | 330 sats; edict assigns the requested Rune amount to the time lock |
| 2 | 330 sats to the owner; pointer = 2 receives unallocated Runes |
| Following output, if needed | Ordinary BTC/FB fee change |

The lower-level builder also permits omitting Rune change when the caller establishes it is unnecessary; the web app intentionally does not use that branch. Asset indexes may change between selection and broadcasting. Rune change/pointer handling does not make arbitrary fee inputs safe for other asset protocols.

## Records and failure handling

Old CSV records remain in `bitcoin_asset_timelock_records`. New records use `bitcoin_asset_timelock_records_v2`, explicit `recordVersion: 2`, `lock`, `ownerPubKey` and `chain`. New-schema CSV records still use BATL v1; record schema and wire protocol versions are separate.

```text
BRC-20: signed chain saved → pending → each broadcast progress → locked
Runes:  one broadcast succeeds → locked
Either: locked → unlock broadcast succeeds → unlocked
```

Those states describe local submission progress, not confirmed chain status. Successful BRC-20 completion removes the temporary signed chain. A failed unlock broadcast does not execute the later `unlocked` write. Uncertain broadcast results or failed storage writes require checking the transaction before repeating an action.

Records are validated for version, condition, identity fields, outpoints, state and optional fields. A malformed namespace is left unchanged; the healthy one can still be displayed, but errors block record writes. Updates compare the saved record against the expected snapshot and detect some stale/cross-tab changes; they cannot provide transactional isolation across tabs.

The original local-record unlock flow uses the saved outpoint and satoshi value; it does not first query that lock output's current unspent state. The separate recovered-unlock flow below adds that verification without rewriting the old flow. Both return the full principal to the owner's first output, with other inputs covering the fee. Runes reuse the same unlock builder without adding another Runestone. Chain confirmation and resulting asset balances must be checked separately.

## What recovery does and does not provide

BATL carries a version, lock condition, owner x-only public key and address type. It does not contain the chain, ticker, Rune ID, amount, private key or pending signed transaction chain. A compatible recovery implementation must select the correct network, decode the marker, rederive and match the actual lock script, and verify the UTXO and asset state.

The public recovery panel accepts a lock transaction ID, a strict public JSON file/text, or an inscription containing that JSON. It selects an explicit chain, recomputes the raw transaction ID, checks a unique supported BATL carrier, and matches the derived script against the actual output. Initial imports restore public references only; a separate check loads confirmation, unspent and asset information. It does not fabricate original creation times, asset amounts, five-transaction history or pending signed PSBTs.

The recovery confirmation check combines separately sampled API replies. It requires the transaction and exact output to report the same positive confirmed height, at or below the chain snapshot, and a positive reported confirmation count. The displayed count is derived from that snapshot; it need not equal a count returned at a different time by another endpoint.

Runes and BRC-20 indexes must cover the particular output's confirmed creation height. They need not reach an unrelated newer chain tip. The blockchain output check separately requires the same outpoint, script, value and address to be explicitly unspent, and the complete inscription/Rune inventories must satisfy the supported asset flow. Fee UTXOs use the same confirmation and per-output Runes coverage rules. These checks still rely on indexer consistency across requests.

Recovered references use the independent `bitcoin_asset_timelock_recovered_v1` namespace. It stores public outpoints, workspace/source, restoration time and an optional unlock-attempt ID, not a trusted asset-state cache. Malformed data is preserved and prevents writes. Compare-before-write guards catch some stale updates but do not provide cross-tab transactions.

Verification results remain in the current session and expire after 60 seconds. Wallet, network, API-key, workspace and observed storage changes invalidate previous checks; connect the intended wallet before verifying for an unlock. `verified` describes indexed output/assets; owner, network and lock maturity are additional conditions for enabling the review button. See the [recovery operating steps and blocked states](PUBLIC-BACKUP.md#if-review-recovered-unlock-is-disabled).

New recovered unlocks recheck the output, indexer completeness, ownership, maturity and selected fee inputs before signing and before broadcast. The existing builder preserves the original condition and returns the principal to the owner. The wallet result must keep every unsigned transaction byte and prevout unchanged, finalize every input, use ALL/DEFAULT signature coverage, and pass signature verification. The attempt ID is saved before broadcast; it means an attempt, not confirmation. Uncertain submissions require checking that ID before any explicit retry.

Public file generation never serializes full records. Actual inscription creation is performed separately by the user in UniSat; the app neither pays for it nor stores wallet authorization on-chain. See the [public format, workflow and limitations](PUBLIC-BACKUP.md).
