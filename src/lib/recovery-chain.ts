import { bitcoin, toPsbtNetwork } from '@unisat/wallet-bitcoin'
import { NetworkType } from '@unisat/wallet-types'
import { Buffer } from 'buffer'
import { ChainType, type OpenApiUtxo, type RuneIndexerBalance } from '../types'
import { CHAIN_SNAPSHOT_TTL_MS, parseBlockchainInfo, requireKnownChain, type BlockchainInfo } from './openapi'
import { buildTimeLockMetadataScript, decodeRunestoneRecoveryMetadata, decodeTimeLockMetadataScript, deriveOwnerAddress, encodeRunestoneRecoveryMetadata, getMetadataLockCondition, getOwnerAddressType, type TimeLockMetadata } from './recovery'
import { assertPlainInscriptionContent, RecoveryApiError, recoveryObject, requestRecoveryData } from './recovery-api'
import { deriveTimeLockAddress } from './timelock'

export type RecoveryAssets =
  | { kind: 'brc20'; inscriptionId: string; ticker: string; amount: string; decimal: number }
  | { kind: 'runes'; balances: RuneIndexerBalance[] }
export type RecoveryInspection = {
  chain: ChainType
  metadata: TimeLockMetadata
  ownerAddress: string
  timeLockAddress: string
  assetKind: 'brc20' | 'runes'
  outpoint: { txid: string; vout: number; satoshi: number; scriptPk: string }
  verification: 'verified' | 'unknown' | 'spent'
  reason?: string
  assets?: RecoveryAssets
  height?: number
  confirmations?: number
  checkedAt: number
}
const MAX_RAW_BYTES = 4_000_000
export const MAX_RECOVERY_FUNDING_CANDIDATES = 6
const U128_MAX = (1n << 128n) - 1n
type Outpoint = { txid: string; vout: number }
type ExactOutput = Outpoint & { satoshi: number; scriptPk: string }
class SpentOutput extends Error {}

function network(chain: ChainType) {
  return toPsbtNetwork(chain === ChainType.BITCOIN_MAINNET || chain === ChainType.FRACTAL_BITCOIN_MAINNET ? NetworkType.MAINNET : NetworkType.TESTNET)
}
function txId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error('Invalid transaction ID.')
  return value.toLowerCase()
}
function outputIndex(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) throw new Error('Invalid output index.')
  return value as number
}
function hexScript(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error('Missing or malformed output script.')
  return value.toLowerCase()
}
function fresh(checkedAt: number, now = Date.now()): void {
  if (!Number.isFinite(checkedAt) || now < checkedAt || now - checkedAt > CHAIN_SNAPSHOT_TTL_MS) throw new Error('Recovery check is stale. Revalidate before continuing.')
}
export function assertRecoveryFresh(inspection: RecoveryInspection, now = Date.now()): void {
  if (inspection.verification !== 'verified' || !inspection.assets) throw new Error('The recovered output and its assets are not verified.')
  fresh(inspection.checkedAt, now)
}

function walletIdentity(address: string, publicKey: string, chain: ChainType): { address: string; publicKey: string; scriptPk: string } {
  const key = publicKey.trim().replace(/^0x/i, '').toLowerCase()
  if (!/^(02|03)[0-9a-f]{64}$/.test(key)) throw new Error('The original wallet must provide its full compressed public key.')
  const normalizedAddress = address.trim().toLowerCase()
  const descriptor = getOwnerAddressType(normalizedAddress, key)
  const derived = deriveOwnerAddress({ version: 1, lockBlocks: 1, xOnlyPubKey: key.slice(2), ownerAddressType: descriptor }, chain)
  if (!derived || derived !== normalizedAddress) throw new Error('Wallet address and public key do not match.')
  return { address: derived, publicKey: key, scriptPk: Buffer.from(bitcoin.address.toOutputScript(derived, network(chain))).toString('hex') }
}

export function assertRecoveryOwner(inspection: RecoveryInspection, address: string, publicKey: string, chain: ChainType | string): void {
  const selected = requireKnownChain(chain)
  if (selected !== inspection.chain) throw new Error('Switch to the recovered output network.')
  const wallet = walletIdentity(address, publicKey, selected)
  if (wallet.address !== inspection.ownerAddress || wallet.publicKey.slice(2) !== inspection.metadata.xOnlyPubKey || getOwnerAddressType(wallet.address, wallet.publicKey) !== inspection.metadata.ownerAddressType) throw new Error('Only the original owner wallet can unlock this output.')
}

async function rawTransaction(txid: string, chain: ChainType, apiKey?: string): Promise<bitcoin.Transaction> {
  const raw = await requestRecoveryData(`/rawtx/${txid}`, chain, apiKey, MAX_RAW_BYTES * 2 + 1024)
  if (typeof raw !== 'string' || raw.length > MAX_RAW_BYTES * 2 || !/^(?:[0-9a-f]{2})+$/i.test(raw)) throw new Error('Missing, oversized or malformed raw transaction.')
  let tx: bitcoin.Transaction
  try { tx = bitcoin.Transaction.fromHex(raw) } catch { throw new Error('Raw transaction cannot be decoded.') }
  if (tx.getId() !== txid) throw new Error('Raw transaction ID does not match the requested transaction.')
  return tx
}

function runeValues(script: Buffer): bigint[] {
  const chunks = bitcoin.script.decompile(script)
  if (!chunks || chunks[0] !== bitcoin.opcodes.OP_RETURN || chunks[1] !== bitcoin.opcodes.OP_13 || !chunks.slice(2).every(Buffer.isBuffer)) throw new Error('Malformed Runestone carrier.')
  const payload = Buffer.concat(chunks.slice(2) as Buffer[])
  const values: bigint[] = []
  let value = 0n
  let shift = 0n
  for (const byte of payload) {
    value |= BigInt(byte & 0x7f) << shift
    if (value > U128_MAX || shift >= 133n) throw new Error('Malformed Runestone integer.')
    if (byte & 0x80) { shift += 7n; continue }
    if (shift > 0n && byte === 0) throw new Error('Noncanonical Runestone integer.')
    values.push(value); value = 0n; shift = 0n
  }
  if (shift !== 0n) throw new Error('Truncated Runestone integer.')
  return values
}

function deriveCandidate(tx: bitcoin.Transaction, chain: ChainType, vout?: number): RecoveryInspection {
  const markers: { metadata: TimeLockMetadata; assetKind: 'brc20' | 'runes'; index: number }[] = []
  for (const [index, output] of tx.outs.entries()) {
    const script = Buffer.from(output.script)
    if (script[0] !== bitcoin.opcodes.OP_RETURN) continue
    const brc = decodeTimeLockMetadataScript(script)
    if (brc) {
      if (!script.equals(buildTimeLockMetadataScript(brc))) throw new Error('Noncanonical BATL marker.')
      markers.push({ metadata: brc, assetKind: 'brc20', index })
    } else if (script[1] === bitcoin.opcodes.OP_13) {
      const values = runeValues(script)
      let markerCount = 0
      for (let offset = 0; offset < values.length && values[offset] !== 0n; offset += 2) {
        if (offset + 1 >= values.length) throw new Error('Truncated Runestone field.')
        if (values[offset] === 127n && values[offset + 1] === 0x4241544cn) markerCount += 1
      }
      const metadata = decodeRunestoneRecoveryMetadata(values)
      if (markerCount > 1) throw new Error('Ambiguous duplicate BATL Runestone markers.')
      if (markerCount && !metadata) throw new Error('Unsupported or corrupt BATL Runestone metadata.')
      if (metadata) {
        const expected = encodeRunestoneRecoveryMetadata(metadata)
        if (expected.some((value, offset) => values[offset] !== value)) throw new Error('Unsupported BATL Runestone layout.')
        const tail = values.slice(expected.length)
        const body = tail[0] === 22n ? tail.slice(2) : tail
        if ((tail[0] === 22n && (tail[1] !== 2n || tx.outs.length <= 2)) || body.length !== 5 || body[0] !== 0n || body[1] > 0xffffffffn || body[2] > 0xffffffffn || body[3] <= 0n || body[4] !== 1n) throw new Error('Unsupported or corrupt BATL Rune allocation layout.')
        markers.push({ metadata, assetKind: 'runes', index })
      }
    } else if (script.includes(Buffer.from('BATL'))) throw new Error('Unsupported or corrupt BATL marker.')
  }
  if (markers.length !== 1) throw new Error('Expected one unambiguous BATL metadata carrier.')
  const marker = markers[0]
  const expectedVout = marker.assetKind === 'brc20' ? 0 : 1
  if (marker.index !== (marker.assetKind === 'brc20' ? 1 : 0) || tx.outs[marker.index].value !== 0 || (vout !== undefined && vout !== expectedVout)) throw new Error('BATL output positions do not match the supported lock format.')
  const ownerAddress = deriveOwnerAddress(marker.metadata, chain)
  const timeLockAddress = deriveTimeLockAddress(marker.metadata.xOnlyPubKey, getMetadataLockCondition(marker.metadata), chain)
  if (!ownerAddress) throw new Error('Cannot derive the BATL owner.')
  const expectedScript = Buffer.from(bitcoin.address.toOutputScript(timeLockAddress, network(chain)))
  const matches = tx.outs.map((output, index) => Buffer.from(output.script).equals(expectedScript) ? index : -1).filter((index) => index >= 0)
  if (matches.length !== 1 || matches[0] !== expectedVout) throw new Error('BATL metadata does not uniquely match the actual lock output script.')
  const output = tx.outs[expectedVout]
  if (output.value !== (marker.assetKind === 'brc20' ? 546 : 330)) throw new Error('Unsupported BATL lock output value.')
  return { chain, metadata: marker.metadata, ownerAddress, timeLockAddress, assetKind: marker.assetKind, outpoint: { txid: tx.getId(), vout: expectedVout, satoshi: output.value, scriptPk: expectedScript.toString('hex') }, verification: 'unknown', reason: 'Asset/UTXO status not checked.', checkedAt: Date.now() }
}

function matchOutput(value: unknown, expected: ExactOutput, address: string): Record<string, unknown> {
  const row = recoveryObject(value, 'output information')
  if (txId(row.txid) !== expected.txid || row.vout !== expected.vout || row.satoshi !== expected.satoshi || hexScript(row.scriptPk) !== expected.scriptPk || row.address !== address) throw new Error('Indexed output does not match the actual transaction, script, value or owner.')
  return row
}
function unspent(row: Record<string, unknown>): void {
  if (row.isSpent === true || row.isSpending === true) throw new SpentOutput('The output is spent or has a pending spend.')
  if (row.isSpent !== false || (row.isSpending !== undefined && row.isSpending !== false) || (row.isLowFee !== undefined && row.isLowFee !== false)) throw new Error('Explicit unspent state is unavailable.')
}

async function chainSnapshot(chain: ChainType, apiKey?: string): Promise<BlockchainInfo> {
  const startedAt = Date.now()
  return parseBlockchainInfo(await requestRecoveryData('/blockchain/info', chain, apiKey), chain, startedAt)
}
async function runeIndexHeight(chain: ChainType, apiKey?: string): Promise<number> {
  const status = recoveryObject(await requestRecoveryData('/runes/status', chain, apiKey), 'Runes indexer status')
  if (!Number.isSafeInteger(status.bestHeight) || (status.bestHeight as number) < 0) throw new Error('Runes indexer returned an invalid height. Asset state is unknown.')
  return status.bestHeight as number
}
function requireRuneCoverage(indexedHeight: number, outputHeight: number): void {
  // Rune allocation is fixed when an output is created. If the blockchain
  // index confirms that the same output is still unspent, the Runes indexer
  // needs to cover its creation height, not an unrelated newer chain tip.
  if (indexedHeight < outputHeight) throw new Error('Runes indexer has not reached the recovered output height. Asset state is unknown.')
}
async function confirmedOutput(expected: ExactOutput, address: string, snapshot: BlockchainInfo, chain: ChainType, apiKey?: string) {
  const data = await requestRecoveryData(`/utxo/${expected.txid}/${expected.vout}`, chain, apiKey)
  if (data === null) throw new SpentOutput('The output is spent or no longer returned by the indexer.')
  const row = matchOutput(data, expected, address)
  unspent(row)
  const summary = recoveryObject(await requestRecoveryData(`/tx/${expected.txid}`, chain, apiKey), 'transaction confirmation')
  const height = row.height as number
  // The API documents `confirmations` as an integer but does not define an
  // exact equality with a separately fetched chain-tip snapshot. Require both
  // endpoints to identify the same confirmed height, then derive the displayed
  // count from this operation's one validated snapshot so cache/tip races do
  // not turn a confirmed output into an unverifiable one.
  if (txId(summary.txid) !== expected.txid || !Number.isSafeInteger(height) || height <= 0 || height !== summary.height || height > snapshot.blocks || !Number.isSafeInteger(summary.confirmations) || (summary.confirmations as number) <= 0) throw new Error('Unconfirmed or inconsistent transaction height. Refresh the snapshot.')
  if (!Array.isArray(row.inscriptions)) throw new Error('Inscription state is unknown.')
  // UniSat may filter used BRC-20 inscriptions from this array while retaining
  // the total count. Missing counts cannot establish a complete asset inventory.
  if (!Number.isSafeInteger(row.inscriptionsCount) || (row.inscriptionsCount as number) < 0 || row.inscriptionsCount !== row.inscriptions.length) {
    throw new Error('Inscription inventory is unknown: its total count is missing, invalid, or differs from the returned details (which may be filtered).')
  }
  return { row, height, confirmations: snapshot.blocks - height + 1 }
}

async function runeBalances(outpoint: Outpoint, chain: ChainType, apiKey?: string): Promise<RuneIndexerBalance[]> {
  const data = await requestRecoveryData(`/runes/utxo/${outpoint.txid}/${outpoint.vout}/balance`, chain, apiKey)
  if (!Array.isArray(data)) throw new Error('Rune balances are unknown; an explicit array is required.')
  const ids = new Set<string>()
  return data.map((value) => {
    const row = recoveryObject(value, 'Rune balance')
    if (typeof row.runeid !== 'string' || !/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(row.runeid) || row.runeid.length > 48 || ids.has(row.runeid) || typeof row.amount !== 'string' || !/^[1-9]\d{0,38}$/.test(row.amount) || BigInt(row.amount) > U128_MAX || !Number.isInteger(row.divisibility) || (row.divisibility as number) < 0 || (row.divisibility as number) > 38) throw new Error('Malformed, zero, duplicate or unsupported Rune balance.')
    ids.add(row.runeid)
    for (const key of ['rune', 'spacedRune', 'symbol']) if (typeof row[key] !== 'string' || (row[key] as string).length > 128) throw new Error('Incomplete Rune identity.')
    return { runeid: row.runeid, amount: row.amount, divisibility: row.divisibility as number, rune: row.rune as string, spacedRune: row.spacedRune as string, symbol: row.symbol as string }
  })
}

function positiveAmount(value: unknown, decimal: number): bigint {
  if (typeof value !== 'string' || value.length > 80 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid BRC-20 amount.')
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimal) throw new Error('BRC-20 amount exceeds its decimal precision.')
  const amount = BigInt(whole + fraction.padEnd(decimal, '0'))
  if (amount <= 0n) throw new Error('BRC-20 amount must be positive.')
  return amount
}
async function brcAssets(candidate: RecoveryInspection, row: Record<string, unknown>, outputHeight: number, apiKey?: string): Promise<RecoveryAssets> {
  const inscriptions = row.inscriptions as unknown[]
  if (inscriptions.length !== 1) throw new Error('Expected exactly one BRC-20 inscription.')
  const inscription = recoveryObject(inscriptions[0], 'BRC-20 inscription')
  const id = `${candidate.outpoint.txid}i0`
  if (inscription.inscriptionId !== id || inscription.offset !== 0 || inscription.isBRC20 !== true || inscription.moved !== false) throw new Error('Unsupported BRC-20 inscription identity, offset or movement state.')
  const status = recoveryObject(await requestRecoveryData('/brc20/status?start=0&limit=1', candidate.chain, apiKey), 'BRC-20 indexer status')
  if (!Number.isSafeInteger(status.height) || (status.height as number) < outputHeight) throw new Error('BRC-20 indexer has not reached the recovered output height. Asset state is unknown.')
  const info = recoveryObject(await requestRecoveryData(`/inscription/info/${id}`, candidate.chain, apiKey), 'BRC-20 inscription metadata')
  assertPlainInscriptionContent(info)
  if (info.inscriptionId !== id || info.offset !== 0 || info.height !== row.height || info.address !== candidate.timeLockAddress) throw new Error('BRC-20 inscription no longer matches the recovered output.')
  const current = matchOutput(info.utxo, candidate.outpoint, candidate.timeLockAddress)
  if (current.height !== row.height) throw new Error('BRC-20 inscription output height is inconsistent.')
  if (current.isSpent !== undefined) unspent(current)
  const brc = recoveryObject(info.brc20, 'BRC-20 transfer metadata')
  const decimal = typeof brc.decimal === 'string' && /^(?:[0-9]|1[0-8])$/.test(brc.decimal) ? Number(brc.decimal) : NaN
  if (brc.op !== 'transfer' || typeof brc.tick !== 'string' || !Number.isInteger(decimal)) throw new Error('Unsupported BRC-20 transfer metadata.')
  const tickerBytes = Buffer.byteLength(brc.tick, 'utf8')
  const fractal = candidate.chain === ChainType.FRACTAL_BITCOIN_MAINNET || candidate.chain === ChainType.FRACTAL_BITCOIN_TESTNET
  // Fractal's official 2025 priorities document 6–12-character tickers; Bitcoin
  // six-byte BRC20-Prog is not this Classic history flow. Preserve exact spelling.
  if (![4, 5].includes(tickerBytes) && !(fractal && /^[a-z0-9]{6,12}$/i.test(brc.tick))) throw new Error('Unsupported ticker on the selected network.')
  const amount = positiveAmount(brc.amt, decimal)
  const history = recoveryObject(await requestRecoveryData(`/brc20/${encodeURIComponent(brc.tick)}/tx/${candidate.outpoint.txid}/history?type=inscribe-transfer&start=0&limit=16`, candidate.chain, apiKey), 'BRC-20 transfer validity')
  if (!Array.isArray(history.detail) || history.start !== 0 || !Number.isSafeInteger(history.total) || (history.total as number) < history.detail.length || history.detail.length > 16) throw new Error('Malformed BRC-20 history.')
  const matching = history.detail.map((value) => recoveryObject(value, 'BRC-20 history entry')).filter((value) => value.inscriptionId === id)
  if (matching.length !== 1 || matching[0].valid !== true || matching[0].type !== 'inscribe-transfer' || matching[0].txid !== candidate.outpoint.txid || matching[0].height !== row.height || positiveAmount(matching[0].amount, decimal) !== amount) throw new Error('BRC-20 transfer validity was not established for this exact inscription.')
  return { kind: 'brc20', inscriptionId: id, ticker: brc.tick, amount: brc.amt as string, decimal }
}

export async function inspectRecoveryOutpoint(params: { chain: ChainType | string; txid: string; vout?: number; apiKey?: string; verifyAssets?: boolean }): Promise<RecoveryInspection> {
  const chain = requireKnownChain(params.chain)
  const txid = txId(params.txid.trim())
  if (params.vout !== undefined) outputIndex(params.vout)
  const candidate = deriveCandidate(await rawTransaction(txid, chain, params.apiKey), chain, params.vout)
  if (params.verifyAssets === false) return candidate
  try {
    const snapshot = await chainSnapshot(chain, params.apiKey)
    const output = await confirmedOutput(candidate.outpoint, candidate.timeLockAddress, snapshot, chain, params.apiKey)
    requireRuneCoverage(await runeIndexHeight(chain, params.apiKey), output.height)
    const balances = await runeBalances(candidate.outpoint, chain, params.apiKey)
    let assets: RecoveryAssets
    if (candidate.assetKind === 'brc20') {
      if (balances.length) throw new Error('Mixed BRC-20 and Rune assets are unsupported.')
      assets = await brcAssets(candidate, output.row, output.height, params.apiKey)
    } else {
      if ((output.row.inscriptions as unknown[]).length || !balances.length) throw new Error('Rune output has mixed, missing or unknown assets.')
      assets = { kind: 'runes', balances }
    }
    fresh(snapshot.checkedAt)
    return { ...candidate, verification: 'verified', reason: undefined, assets, height: output.height, confirmations: output.confirmations, checkedAt: snapshot.checkedAt }
  } catch (error) {
    return { ...candidate, verification: error instanceof SpentOutput ? 'spent' : 'unknown', reason: error instanceof Error ? error.message : 'Asset verification is unavailable.' }
  }
}

function sameOutpoint(a: Outpoint, b?: Outpoint): boolean { return !!b && a.txid.toLowerCase() === b.txid.toLowerCase() && a.vout === b.vout }
async function verifyFundingOne(candidate: OpenApiUtxo, wallet: ReturnType<typeof walletIdentity>, snapshot: BlockchainInfo, runeHeight: number, chain: ChainType, apiKey?: string): Promise<OpenApiUtxo> {
  const id = txId(candidate.txid)
  const vout = outputIndex(candidate.vout)
  if (!Number.isSafeInteger(candidate.satoshi) || candidate.satoshi <= 0 || hexScript(candidate.scriptPk) !== wallet.scriptPk || (candidate.address !== undefined && candidate.address !== wallet.address) || (candidate.isSpent !== undefined && candidate.isSpent !== false) || (candidate.isSpending !== undefined && candidate.isSpending !== false) || (candidate.isLowFee !== undefined && candidate.isLowFee !== false)) throw new Error('Unsupported funding candidate.')
  const tx = await rawTransaction(id, chain, apiKey)
  const actual = tx.outs[vout]
  if (!actual || actual.value !== candidate.satoshi || Buffer.from(actual.script).toString('hex') !== wallet.scriptPk) throw new Error('Funding candidate does not match its raw transaction.')
  const expected = { txid: id, vout, satoshi: actual.value, scriptPk: wallet.scriptPk }
  const checked = await confirmedOutput(expected, wallet.address, snapshot, chain, apiKey)
  requireRuneCoverage(runeHeight, checked.height)
  if ((checked.row.inscriptions as unknown[]).length || (await runeBalances(expected, chain, apiKey)).length) throw new Error('Funding output carries inscriptions or Runes.')
  fresh(snapshot.checkedAt)
  return { ...expected, address: wallet.address, height: checked.height, isSpent: false, isSpending: false }
}

/** Checks only the supported inscription/Runes indexes, not every asset protocol. */
export async function verifyRecoveryFunding(utxos: OpenApiUtxo[], address: string, pubKey: string, selectedChain: ChainType | string, apiKey?: string, excludeOutpoint?: Outpoint): Promise<OpenApiUtxo[]> {
  const chain = requireKnownChain(selectedChain)
  const wallet = walletIdentity(address, pubKey, chain)
  if (!Array.isArray(utxos) || !utxos.length || utxos.length > MAX_RECOVERY_FUNDING_CANDIDATES || new Set(utxos.map((value) => `${txId(value.txid)}:${outputIndex(value.vout)}`)).size !== utxos.length || utxos.some((value) => sameOutpoint(value, excludeOutpoint))) throw new Error('Invalid, duplicate or locked funding input selection.')
  const snapshot = await chainSnapshot(chain, apiKey)
  const runeHeight = await runeIndexHeight(chain, apiKey)
  const verified: OpenApiUtxo[] = []
  for (const candidate of utxos) verified.push(await verifyFundingOne(candidate, wallet, snapshot, runeHeight, chain, apiKey))
  fresh(snapshot.checkedAt)
  return verified
}

export async function getVerifiedRecoveryFunding(address: string, pubKey: string, selectedChain: ChainType | string, apiKey?: string, excludeOutpoint?: Outpoint): Promise<OpenApiUtxo[]> {
  const chain = requireKnownChain(selectedChain)
  const wallet = walletIdentity(address, pubKey, chain)
  const data = recoveryObject(await requestRecoveryData(`/address/${encodeURIComponent(wallet.address)}/available-utxo-data?cursor=0&size=${MAX_RECOVERY_FUNDING_CANDIDATES}`, chain, apiKey), 'funding candidate list')
  if (!Array.isArray(data.utxo)) throw new Error('Funding candidates are unknown; an explicit UTXO array is required.')
  const candidates = data.utxo as OpenApiUtxo[]
  const snapshot = await chainSnapshot(chain, apiKey)
  const runeHeight = await runeIndexHeight(chain, apiKey)
  const verified: OpenApiUtxo[] = []
  const seen = new Set<string>()
  // No pagination, background scan or parallel probing. A transport failure stops
  // the whole batch, including when earlier candidates looked usable.
  for (const candidate of candidates.slice(0, MAX_RECOVERY_FUNDING_CANDIDATES)) {
    try {
      if (sameOutpoint(candidate, excludeOutpoint)) continue
      const id = `${txId(candidate.txid)}:${outputIndex(candidate.vout)}`
      if (seen.has(id)) continue
      seen.add(id)
      verified.push(await verifyFundingOne(candidate, wallet, snapshot, runeHeight, chain, apiKey))
    } catch (error) { if (error instanceof RecoveryApiError) throw error }
  }
  fresh(snapshot.checkedAt)
  if (!verified.length) throw new Error('No confirmed funding output with known-empty inscription and Rune balances was found in the bounded candidate set.')
  return verified
}
