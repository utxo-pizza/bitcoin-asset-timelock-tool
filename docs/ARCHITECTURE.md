# Architecture and recovery boundaries

The application coordinates a browser, UniSat, the selected chain and asset indexers. It does not operate a backend, hold private keys or automatically unlock assets. Start with the [README](../README.md) for usage and [BATL](BATL-PROTOCOL.md) for exact recovery bytes.

## Responsibilities

```text
Browser: choose asset/condition → build transaction → request wallet approval
   │                                  │
   ├─ OpenAPI: chain MTP, balances, UTXOs and fees
   ├─ LocalStorage: key, records, pending signed BRC-20 chain
   └─ UniSat: sign → submit to its broadcast service
                         │
                         └─ Chain validation + asset indexing decide the result
```

The browser's prechecks and local labels are not the chain's consensus or asset state. APIs are trusted for the configured network; a response's optional `chain` string is not an independent network proof. Users review the actual wallet network, transaction and outputs before signing.

## Independent workspaces, shared execution

`#/csv` shows relative-block inputs and CSV records. `#/cltv` shows fixed UTC inputs, MTP and CLTV records. Empty or unknown fragments resolve to CSV. Each workspace owns its in-memory asset selection, amount, lock parameters, manual fee override and result. Changing pages does not migrate records; reloading discards unsaved drafts.

A shared operation gate prevents overlapping create/resume/unlock operations in one tab. Navigation, direct fragment changes and browser back/forward cannot switch workspaces during confirmation, signing or broadcasting. Wallet provider, account, public key, network, API configuration and saved-record identity are checked across asynchronous boundaries. This is not a lock across multiple browser tabs.

## Lock conditions

| Condition | Output script | Unlock transaction |
| --- | --- | --- |
| CSV: integer 1–65,535 blocks | CSV check, drop, owner signature | Version 2, locktime 0, locked input sequence = blocks |
| CLTV: Unix seconds | CLTV check, drop, owner signature | Version 2, locktime = original timestamp, locked input sequence = `0xfffffffe` |

Both use one Taproot leaf and the fixed NUMS internal point specified by BATL. Its private key is not known; the intended spend path is the committed script plus the owner's signature. BATL public metadata is not the enforcement mechanism.

CLTV input is interpreted as UTC, not browser-local time. Creating a new lock requires `target > fresh MTP`; normal unlocking requires `MTP > target`. Equal values fail both respective future/maturity checks. Chain snapshots are bound to a selected endpoint/network with a 60-second validity window and a 15-second request timeout. The device clock only helps detect snapshot staleness, not maturity.

The untouched CLTV date field starts at MTP as a reference; it adds no default duration. User edits, clearing and invalid text are preserved across MTP refreshes. New deposits reject the last two representable uint32 timestamps; raw recovery and existing records preserve them without calling them mature. [BATL's timestamp rules](BATL-PROTOCOL.md#94-creation-maturity-and-spending) explain the boundary.

`Test Unlock (skip MTP)` adds a one-attempt confirmation before bypassing only the web precheck. It does not persist a flag, change the script/PSBT or bypass identity checks. It may actually unlock an already-mature output. See [validation](VALIDATION.md#interpreting-the-fractal-result) for how to interpret errors.

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

Unlock reconstruction uses the saved outpoint and satoshi value; it does not first query that lock output's current unspent state. The full principal returns to the owner's first output and other inputs cover the fee. Runes reuse this same unlock builder without adding another Runestone. Chain confirmation and resulting asset balances must be checked separately.

## What recovery does and does not provide

BATL carries a version, lock condition, owner x-only public key and address type. It does not contain the chain, ticker, Rune ID, amount, private key or pending signed transaction chain. A compatible recovery implementation must select the correct network, decode the marker, rederive and match the actual lock script, and verify the UTXO and asset state.

The repository provides encoding/decoding and derivation primitives, **not** a complete transaction-ID recovery or record-import screen. Full local records contain more application data than BATL. Keep records privately backed up; changing domains, browser profiles or devices will not transfer them automatically.
