# Bitcoin Asset Time Lock · UTXO Pizza

A browser-based tool for locking BRC-20 transfer inscriptions and Runes in Taproot outputs. Transactions are built locally; UniSat handles signing and broadcasting. No private key or seed phrase is requested.

[Open the live app](https://timelock-tool.utxo.pizza/) · [CSV relative blocks](https://timelock-tool.utxo.pizza/#/csv) · [CLTV fixed UTC date](https://timelock-tool.utxo.pizza/#/cltv)

> Public backup and recovery is deployed to the linked live app as of 2026-09-13. It remains dependent on the selected APIs/indexers and still needs user-operated live-wallet, inscription and mature-unlock acceptance testing.

This is the **UTXO Pizza community-maintained fork** of [UniSat's Bitcoin Asset Time Lock](https://github.com/unisat-wallet/bitcoin-asset-timelock-tool). It adds fixed-date CLTV locks, separate workspaces, Chain MTP-based date handling, public recovery files and inscription-based recovery, stricter record and operation checks, and regression tests. It is not an official UniSat deployment or an independently audited custody product. The original [MIT license and copyright notice](LICENSE) are preserved.

## Choose the right lock

| | CSV: relative blocks | CLTV: fixed UTC date |
| --- | --- | --- |
| Page | `#/csv` | `#/cltv` |
| Condition | Wait 1–65,535 blocks after the locked output confirms | Wait until the original network's median-time-past (MTP) is strictly later than the target |
| Clock | Confirmed block age | Chain MTP, not your computer clock |
| BATL marker | v1 | v2 |
| New-lock limit | 65,535 blocks | `2106-02-07 06:28:13 UTC` under current timestamp rules |

CLTV is a fixed date, not a fresh duration beginning at confirmation. Confirmation delays can shorten the remaining wait. Reaching either condition does **not** automatically transfer the asset: the owner must sign an unlock transaction and pay its fee. This app does not expose CSV relative-time locks or CLTV block-height locks.

## Supported asset flows

- **BRC-20 transfer inscriptions:** the existing Fractal-oriented five-transaction flow—self-inscribe, send to the time-lock address, then inscribe at that address. The managed lock is the fifth transaction's output `0`, with 546 sats. This is not a generic Ordinals NFT selection tool.
- **Runes:** one Runestone transaction assigns the requested integer base-unit amount to locked output `1`, with 330 sats. The web app always keeps a 330-sat Rune-change output at `2` and `pointer = 2`; ordinary fee change follows it.
- **Networks available in the selector:** Bitcoin Mainnet, Testnet4, Signet, Fractal Mainnet and Fractal Testnet. Network availability in the UI is not a claim that every asset flow has been validated on every network. Bitcoin and Fractal mainnet both use `bc` addresses; the prefix cannot identify the chain.

Both unlock flows return the locked output's full satoshi value to the owner's first output; separate inputs fund the fee. Do not use unrelated asset-bearing UTXOs as fee inputs. Asset balances and ownership remain subject to the relevant chain and indexer rules.

## Use the app

1. Connect the intended UniSat account and network. Native P2WPKH and P2TR wallet addresses are supported; P2PKH/P2SH are not.
2. Enter your UniSat OpenAPI key in Wallet Setup. It is stored in this browser, not in the published application bundle.
3. Open CSV or CLTV, choose the asset, amount and fee rate, and set the lock condition.
4. For CLTV, load Chain MTP and enter a strictly later UTC target (`YYYY-MM-DD HH:mm:ss`). The initial MTP value is only a reference, not a valid future lock. Refreshing MTP does not overwrite your edited target.
5. Review the network, original target, lock address, outputs and fee in the app and wallet before signing.
6. Keep the local record and transaction IDs. After maturity, use the same account and network to unlock.

CSV and CLTV have separate in-tab drafts, records and results. Reloading resets unsaved drafts, not saved records. Navigation is blocked while an operation is awaiting confirmation, signing or broadcasting.

### Records and interrupted BRC-20 broadcasts

BRC-20's five signed PSBTs are saved **before** the first broadcast, then submitted sequentially. `Continue Broadcast` resumes that original signed chain and target; the process is not atomic. Pending BRC-20 work blocks another BRC-20 creation for the same account/network from either workspace.

Detailed records live in this origin's LocalStorage. Changing sites does not transfer them. Public recovery below can locate existing BATL outputs, but cannot restore an unfinished five-transaction chain or its signed PSBTs. Do not clear site data or operate the same record from multiple tabs. Pending signed PSBTs are broadcast-capable authorization data and must not be posted publicly.

`locked` and `unlocked` mean the application received a broadcast result, **not** that a transaction is confirmed, mature or still unspent. The app does not continuously monitor confirmations, reorganizations or external spends.

### Public backup and recovery

Use **Public backup & recovery** in the relevant CSV or CLTV workspace. A public recovery file contains only its format/version, the network and up to 20 locked outpoints; no private keys, API keys, signatures or full local records are exported.

1. Select references on the original network, review the JSON, and download the file. Verify the original lock and its confirmations before paying to inscribe.
2. To archive it on-chain, personally inscribe that file with UniSat on the **same network**, using ordinary fee funds and your own receiving address. The app does not place or pay for an inscription order. Downloading a file is not an on-chain backup.
3. Keep the backup inscription ID separately. After losing local records, restore from the original lock transaction ID, the public JSON file/text, or the backup inscription ID.
4. Verify the recovered output and assets, then use the original wallet key/address type and network to review an unlock after maturity. Unknown, incomplete or spent outputs cannot proceed.

The original lock still requires its owner's signature. Owning or copying a backup inscription does not transfer that authority. Recovery depends on historical transaction access and supported indexers; it is not a private-key backup, automatic wallet-wide discovery, or an unconditional permanence guarantee. See the [public backup guide and format](docs/PUBLIC-BACKUP.md).

### Explicit CLTV test unlock

`Test Unlock (skip MTP)` asks for a separate confirmation on each attempt, then skips only the website's maturity precheck. It preserves the original script, target, transaction locktime, sequence, ownership checks and fees. There is no persistent bypass switch; normal `Check & Unlock` and new-lock checks remain protected. CSV has no CLTV test entry.

This is a real signing and broadcast attempt, not a simulation. A mature transaction may actually spend the asset and fee. Errors identify the stage and retain the wallet's message. A signing refusal is not a node rejection; `non-final` is consistent with an unmet absolute lock, but does not establish that all later script, signature and asset checks would pass.

## Validation status

- The maintainer reports that their CSV tests passed.
- For CLTV, a user-operated Fractal BRC-20 attempt returned `non-final` at the wallet broadcast stage after skipping the web precheck. The original public lock output was also matched to the CLTV template.
- The repository has local synthetic transaction, record/API and browser regression tests. Historical isolated Bitcoin Core regtest and `ord` results are documented separately.
- CLTV maturity followed by successful live unlock, confirmation and BRC-20 balance reconciliation remains outstanding. No comprehensive audit or all-network compatibility guarantee is claimed.

See [validation evidence and limits](docs/VALIDATION.md) before interpreting those results or using meaningful funds.

## Run locally

Use Node.js 24 for the documented validation setup and the committed npm lockfile.

```bash
npm ci
npm test
npm run docs:check
npm run dev -- --host 127.0.0.1
```

For a production build:

```bash
npm run build
npm run preview -- --host 127.0.0.1
```

No API key is needed for local automated tests. The default `dev` and `preview` scripts bind all interfaces unless you override `--host` as above. Do not expose a development server unintentionally.

## Documentation and contributions

- [Documentation guide](docs/index.md): where to start as a user, contributor or operator.
- [Development and tests](docs/DEVELOPMENT.md): prerequisites, browser harness, environment settings and source map.
- [Deploy your own instance](docs/DEPLOYMENT.md): Cloudflare Pages and optional GitHub Pages; never bundle secrets.
- [BATL protocol](docs/BATL-PROTOCOL.md): exact v1/v2 encoding and recovery contracts.
- [Contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md): safe changes and private vulnerability reports.
- [Architecture and recovery boundaries](docs/ARCHITECTURE.md): data flow, records, ownership and implementation limits.

Keep upstream acknowledgements and license notices in redistributed copies. Report issues with this fork to this repository; do not imply that UTXO Pizza-specific behavior is supported by upstream UniSat.
