# BATL Protocol Specification

## Bitcoin Asset Time Lock Recovery Marker

**Status:** Draft / implementation specification for the UTXO Pizza fork

**Versions:** 1 (relative blocks), 2 (absolute UTC time)

`BATL` means **Bitcoin Asset Time Lock**. It is a public, versioned recovery marker for a Bitcoin asset locked by a Taproot time lock. It enables a compatible explorer, wallet, or recovery tool to recover the public parameters required to re-derive the lock address after an application's local state has been lost. Sections 1–8 specify the unchanged v1 format; Section 9 adds v2 without reinterpreting any v1 field.

BATL does not contain private keys, signatures, seed phrases, or an unlock transaction.

## 1. Goals

BATL v1 provides enough public information to:

1. identify a transaction as a BATL time-lock transaction;
2. recover the relative block lock period, owner x-only public key, and owner address type;
3. deterministically re-derive both the owner address and expected Taproot lock output; and
4. reconstruct an unlock record or an address-to-time-lock index by inspecting the transaction and current UTXO state.

BATL does not define a token protocol. BRC-20 transfer inscriptions and Runes Runestones retain their native semantics.

## 2. Constants

| Name | Value |
| --- | --- |
| Magic | ASCII `BATL` (`0x4241544c`) |
| BATL version | `1` |
| Supported relative locks | `1`–`65535` blocks |
| Taproot leaf version | `0xc0` |
| Internal Taproot key | `50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0` (NUMS example point from BIP341) |
| Runes Nop tag | `127` |

The internal Taproot key is part of the BATL v1 address derivation. Implementations MUST use the exact value above for BATL v1 recovery.

This is the [NUMS (nothing-up-my-sleeve) example point given in BIP341](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki#constructing-and-spending-taproot-outputs). No corresponding private key is known; the intended spend path is the committed script and owner signature. BATL fixes this point for deterministic recovery, rather than following BIP341's separate randomized-internal-key privacy suggestion. Do not treat the key choice alone as a complete security guarantee.

## 3. Lock Script and Address Derivation

Let `blocks` be an integer from `1` to `65535`, and let `owner_xonly_pubkey` be the 32-byte x-only public key from BATL metadata.

The BATL v1 tapscript is:

```text
<blocks> OP_CHECKSEQUENCEVERIFY OP_DROP <owner_xonly_pubkey> OP_CHECKSIG
```

The script is placed in a single Taproot leaf with leaf version `0xc0`, using the fixed internal key in Section 2. The resulting P2TR output key and address are the BATL time-lock address.

To unlock, the locked output is spent through that script path with:

```text
nVersion  = 2
nSequence = blocks
```

The owner signs with the public key committed in the script. The relative lock is evaluated from the confirmation of the locked UTXO, not from BATL metadata creation time.

## 4. BRC-20 Encoding

BRC-20 BATL recovery metadata is a dedicated, zero-satoshi `OP_RETURN` output in the final lock/reveal transaction.

```text
OP_RETURN
  PUSH("BATL")
  PUSH(version)
  PUSH(blocks)
  PUSH(owner_xonly_pubkey)
  PUSH(owner_address_type)
```

### 4.1 Binary layout

| Field | Size | Value |
| --- | ---: | --- |
| `magic` | 4 bytes | ASCII `BATL` |
| `version` | 1 byte | `0x01` |
| `blocks` | 2 bytes | unsigned big-endian relative block count (`1`–`65535`) |
| `owner_xonly_pubkey` | 32 bytes | BIP340 x-only public key |
| `owner_address_type` | 1 byte | Section 4.2 enum |

Bitcoin Script minimal pushes are used. The canonical BATL v1 script shape is therefore:

```text
OP_RETURN PUSH("BATL") PUSH(0x01) PUSH(uint16_be(blocks)) PUSH(xonly_pubkey) PUSH(owner_address_type)
```

The table describes logical field bytes, not literal push opcodes. Canonical version 1 and version 2 encode as `OP_1` (`0x51`) and `OP_2` (`0x52`) respectively under minimal Script pushes; `PUSH(0x01)` is not a requirement to emit `01 01`.

### 4.2 Owner address type

BATL v1 stores an address type instead of the owner address string. Together with the x-only public key and the chain being indexed, it permits an indexer to deterministically reconstruct the original owner address.

| Value | Name | Owner address derivation |
| ---: | --- | --- |
| `81` | `P2TR` | Derive BIP86 P2TR using the x-only key as internal key |
| `82` | `P2WPKH_EVEN` | Prefix x-only key with `0x02`, then derive P2WPKH |
| `83` | `P2WPKH_ODD` | Prefix x-only key with `0x03`, then derive P2WPKH |

BATL v1 supports only native SegWit P2WPKH and BIP86 P2TR owner addresses. These values are wire-compatible with UniSat `SingleStepTransferAddressType` (`P2TR_EMPTY`, `P2WPKH_EVEN`, and `P2WPKH_ODD`). Bitcoin and Fractal mainnet use the `bc` address family; all supported test chains use `tb`.

### 4.3 Output layout

In the final BRC-20 BATL reveal transaction:

| Vout | Purpose |
| ---: | --- |
| `0` | Locked BRC-20 transfer inscription output, 546 sats in this implementation |
| `1` | Zero-satoshi BATL `OP_RETURN` recovery marker |

The BRC-20 transfer inscription remains at output `0` of the fifth transaction in the reference application's five-transaction flow. Do not substitute the third transaction's output or another output at the same address. See the [asset flow](ARCHITECTURE.md#brc-20).

## 5. Runes Encoding

BATL Rune transactions MUST use exactly one `OP_RETURN`: the Runestone output. BATL metadata is therefore embedded inside that existing Runestone, rather than emitted as a second `OP_RETURN` output.

### 5.1 Runestone Nop fields

Runestone fields are LEB128-encoded integer pairs. BATL v1 writes the following repeated `Nop` tag (`127`) pairs before `Tag.Body` (`0`):

```text
127, 0x4241544c,             # BATL magic
127, 1,                      # BATL version
127, blocks,                 # 1 to 65535
127, owner_xonly_pubkey_high,  # first 16 bytes as unsigned big-endian u128
127, owner_xonly_pubkey_low,   # last 16 bytes as unsigned big-endian u128
127, owner_address_type         # Section 4.2 enum
```

Runestone integers are limited to `u128`. The 32-byte x-only public key MUST therefore be represented by two unsigned 128-bit big-endian halves. Each half MUST be left-padded to 16 bytes before concatenating `high || low` to recover the 32-byte x-only public key.

All six BATL Nop pairs MUST be consecutive and appear before `Tag.Body`. A standard Runestone decoder ignores unknown odd tags, including tag `127`; correctly encoded BATL fields do not themselves alter the edicts/pointer or create a cenotaph. This does not guarantee that the remainder of a malformed Runestone is valid. See the [ord Runestone specification](https://docs.ordinals.com/runes/specification.html).

The remaining Runestone fields are standard:

```text
[optional Tag.Pointer, pointer_output]
Tag.Body, rune_id_block_delta, rune_id_tx_delta, amount, destination_output
```

### 5.2 Output layout

| Vout | Purpose |
| ---: | --- |
| `0` | The only `OP_RETURN`: Runestone with embedded BATL Nop fields |
| `1` | 330-satoshi BATL Rune time-lock output |
| `2` | Optional 330-satoshi Rune change output |
| After the asset outputs | Optional normal BTC/FB fee change (vout `3` when Rune change exists, otherwise potentially vout `2`) |

The Rune edict assigns the locked amount to output `1`.

If any Rune balance must remain outside the lock, the Runestone includes `Tag.Pointer = 2` and creates output `2` to the owner address. This is required if:

- the selected Rune UTXO(s) contain more of the locked Rune than the requested amount;
- a selected Rune UTXO carries another Rune; or
- an additional fee input carries a Rune.

The lower-level builder can omit the Rune-change output and pointer if the caller establishes that no unallocated Rune balance needs that destination. This describes a builder option, not the current web interface: **the web app always reserves vout `2` with 330 sats and `pointer = 2`**, including when fee inputs are selected automatically. Omitting Rune change must not be confused with omitting a later ordinary fee-change output.

## 6. Recovery Algorithm

The following is the recovery contract for compatible tooling. The reference application's supported recovery subset and indexer checks are described in the [public recovery guide](PUBLIC-BACKUP.md). Given a candidate transaction on an explicitly selected network:

1. Locate BATL metadata:
   - for BRC-20, find a zero-satoshi output matching the Section 4 script; or
   - for Runes, find the Runestone output (`OP_RETURN OP_13`), decode its LEB128 payload, and locate the six Nop fields in Section 5.
2. Interpret the BATL application's asset-family convention from the carrier: outer BATL OP_RETURN for the BRC-20 flow, or BATL Nop fields inside a Runestone for Runes. This is not proof of the asset's existence or validity. Validate version, block count, owner address type and the 32-byte x-only public key.
3. Reconstruct the owner address using Section 4.2, then rebuild the Section 3 tapscript and Taproot address using the BATL v1 internal key.
4. Validate that the expected locked output has the resulting P2TR script:
   - BRC-20: output `0`;
   - Runes: output `1`.
5. Confirm that the output remains unspent and retrieve its indexed confirmation height.
6. Create an unlock record containing the transaction ID, locked vout, asset kind, owner address, lock blocks, time-lock address, and locked output satoshi value.
7. Build an unlock transaction with `nSequence = blocks` only after the relative lock is mature.

A recovery tool MUST refuse to create an unlock record if the derived P2TR script does not exactly match the selected transaction output.

## 7. Compatibility and Security

- BATL v1 is an application protocol marker, not a consensus rule.
- BATL metadata is public and linkable. It reveals the owner public key, address type, asset family, and chosen lock period.
- Indexers SHOULD key owner lookups by the reconstructed owner `scriptPubKey` (or its hash), not by a display address string.
- A BATL marker alone does not prove that a transaction is valid. Recovery software MUST re-derive and verify the lock output script.
- Runes implementations MUST NOT add a second `OP_RETURN` for BATL metadata. Use the Nop fields in Section 5.
- Implementations MUST preserve the Runestone edict destination and pointer indices specified in Section 5.
- Local records remain a convenience layer. Users SHOULD retain lock transaction IDs independently.

## 8. Reference Implementation

The reference TypeScript encoder and decoders are available in:

- [Recovery encoders and decoders](../src/lib/recovery.ts)
- [Runestone encoding](../src/lib/runestone.ts)
- [Lock scripts and transaction construction](../src/lib/timelock.ts)
- [Public recovery directory format](../src/lib/recovery-manifest.ts)
- [Current output and asset verification](../src/lib/recovery-chain.ts)
- [Recovered unlock execution](../src/lib/recovery-unlock.ts) and [signed transaction checks](../src/lib/signed-transaction.ts)

This fork preserves the upstream v1 format and adds v2. [Core regression tests](../tests/core.test.ts) contain fixed CSV/BATL v1 examples and v2 boundary checks. See [architecture](ARCHITECTURE.md) for the difference between these primitives and the application UI.

The application also implements the separate `batl-recovery` JSON directory described in the [public backup guide](PUBLIC-BACKUP.md#public-file-format). Its version `1` names the directory format and can reference either BATL v1 CSV or BATL v2 CLTV outputs; the UI handles one lock workspace per import. The directory contains only network/outpoint pointers. The original transaction supplies the BATL parameters, and its output script continues to enforce the original owner and lock condition.

## 9. BATL v2: Absolute UTC Time

BATL v2 commits to a fixed Unix timestamp, not a duration starting when the deposit confirms. A later confirmation shortens the remaining wait; it does not move the target date. The supported asset flows and output positions remain those in Sections 4.3 and 5.2. This version does not add a generic Ordinals NFT deposit flow.

### 9.1 Condition and address derivation

The v2 metadata condition is `lockTime`, an integer Unix second in the timestamp range of transaction `nLockTime` (`500000000` through `4294967295`, inclusive). A value below `500000000` is a block-height lock and MUST NOT be interpreted as a v2 timestamp. Representability alone is not a guarantee that a target can mature; see Section 9.4.

The v2 tapscript is:

```text
<lockTime> OP_CHECKLOCKTIMEVERIFY OP_DROP <owner_xonly_pubkey> OP_CHECKSIG
```

The internal NUMS key, single-leaf construction, leaf version, owner public key and owner-address enum are unchanged from v1. The timestamp operand MUST use minimal Bitcoin Script number encoding (little-endian signed magnitude). Positive timestamps from `2147483648` onward need a fifth, zero sign byte. The four-byte big-endian recovery field below is NOT the script-number encoding.

### 9.2 BRC-20 carrier

The field order and output positions are unchanged. Only the version and lock field differ:

```text
OP_RETURN PUSH("BATL") PUSH(0x02) PUSH(uint32_be(lockTime)) PUSH(xonly_pubkey) PUSH(owner_address_type)
```

`lockTime` MUST occupy exactly four bytes, unsigned big-endian. V1 remains `0x01` followed by a two-byte unsigned big-endian relative block count. A decoder MUST reject an unknown version, a mismatched lock-field length or an invalid value; it MUST NOT fall back to another version.

### 9.3 Rune carrier

V2 retains the same six repeated Nop fields and single Runestone output:

```text
127, 0x4241544c,
127, 2,
127, lockTime,
127, owner_xonly_pubkey_high,
127, owner_xonly_pubkey_low,
127, owner_address_type
```

The Runestone uses its normal unsigned LEB128 integer encoding, not the BRC-20 carrier's fixed-width encoding. The version determines the meaning and validation of the third value. Edicts, the pointer and any Rune-change output retain their native meanings; changing the marker version MUST NOT change their output indices or asset allocation.

### 9.4 Creation, maturity and spending

Creating a v2 lock commits the future condition in an output. Creation transactions retain `nLockTime = 0`: they do not themselves wait for the future CLTV target, although wallet, funding and broadcast-service acceptance still apply. The web app requires `target > fresh selected-network MTP` before creating a new lock. The reference unlock builder uses:

```text
nVersion                 = 2
nLockTime                = lockTime
locked-input nSequence   = 0xfffffffe
```

The non-final sequence enables transaction locktime and disables a relative BIP68 delay. The owner still signs the committed script path. [BIP65](https://github.com/bitcoin/bips/blob/master/bip-0065.mediawiki) defines the script/transaction constraints; [BIP342](https://github.com/bitcoin/bips/blob/master/bip-0342.mediawiki) retains CLTV in tapscript.

Under [BIP113](https://github.com/bitcoin/bips/blob/master/bip-0113.mediawiki), a candidate block can include the unlock only when the previous tip's median-time-past (MTP) is **strictly greater** than `lockTime`. Equality is not mature. A browser clock, an API request timestamp, or the newest block's timestamp is not a substitute for MTP. A date shown in UTC is a target condition, not a promise of spendability at that wall-clock second.

Normal web unlocking rechecks MTP before wallet signing. The separate, explicitly confirmed `Test Unlock (skip MTP)` action for original local CLTV records skips only that web precheck for one attempt; it does not change the script, target or transaction fields above. Recovered references do not expose that action. It is not a protocol feature that disables CLTV.

[Block header time](https://developer.bitcoin.org/reference/block_chain.html#block-headers) is an unsigned 32-bit value and a new block must have time strictly greater than its predecessor's MTP. The final two representable target seconds therefore cannot have a confirming block under these rules: inclusion requires `lockTime < previous-tip MTP < new-block time <= 4294967295`. Applications MUST NOT offer such targets for new deposits. The reference application's creation limit is `4294967293` (`2106-02-07 06:28:13 UTC`); this mathematical limit does not guarantee future chain availability. The wire decoder can still identify larger representable conditions without misinterpreting them as CSV, and the UI preserves those records but does not report them as spendable.

### 9.5 Recovery and compatibility

Recovery follows Section 6, except that it validates and derives the v2 CLTV condition and uses MTP instead of a relative confirmation count. A recovery tool MUST verify the actual locked output, owner, network and unspent state before constructing a spend. BATL metadata does not prove asset balances, maturity, network identity or indexer acceptance.

Existing v1 locks, scripts, addresses and markers remain v1. V1-only tools are not assumed to recognize v2. The reference application supports transaction-ID and public-file/inscription recovery for its supported output templates. This does not restore the original five-transaction application history. Local record versions, public recovery-file versions and BATL wire versions are separate: a file or record version MUST NOT be used to infer the script condition.

V2 has repository-level synthetic coverage and recorded historical Bitcoin Core regtest/`ord` checks. A user-operated Fractal BRC-20 premature attempt also returned `non-final` through the wallet broadcast path, with the original lock output matched separately to the CLTV template. Mature live unlock, balance-indexer reconciliation, live Runes coverage and third-party recovery support are not thereby established. See the [validation evidence and limits](VALIDATION.md) rather than treating this protocol document as an audit certificate.
