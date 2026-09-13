import { bitcoin } from '@unisat/wallet-bitcoin'
import type { BuiltTimeLockUnlockTx, ChainType, OpenApiUtxo, UnisatSignInput } from '../types'
import { assertRecoveryFresh, assertRecoveryOwner, type RecoveryInspection } from './recovery-chain'
import type { RecoveryReference } from './recovered-records'
import { getMetadataLockCondition } from './recovery'
import { CHAIN_SNAPSHOT_TTL_MS, isCltvMature, type BlockchainInfo } from './openapi'
import { buildTimeLockUnlockTx } from './timelock'
import { normalizeSignedPsbtToHex, toUniSatSignInputs } from './psbt'
import { assertSignedTransactionMatches, signedTxId } from './signed-transaction'

export type RecoveryUnlockReview = {
  inspection: RecoveryInspection
  transaction: BuiltTimeLockUnlockTx
  previousAttempt?: string
}

export type RecoveryUnlockPorts = {
  inspect: (reference: RecoveryReference) => Promise<RecoveryInspection>
  funding: (inspection: RecoveryInspection) => Promise<OpenApiUtxo[]>
  verifyFunding: (selected: OpenApiUtxo[], inspection: RecoveryInspection) => Promise<OpenApiUtxo[]>
  chainInfo: () => Promise<BlockchainInfo>
  assertCurrent: (expected: RecoveryReference) => Promise<void>
  confirm: (review: RecoveryUnlockReview) => Promise<boolean>
  sign: (hex: string, options: { autoFinalized: boolean; toSignInputs: UnisatSignInput[] }, beforeSign: () => Promise<void>) => Promise<string>
  saveAttempt: (expected: RecoveryReference, txid: string) => RecoveryReference
  broadcast: (hex: string) => Promise<string>
  stage?: (message: string) => void
  prepared?: (txid: string) => void
}

export function assertRecoveryMature(inspection: RecoveryInspection, info: BlockchainInfo, now = Date.now()): void {
  assertRecoveryFresh(inspection, now)
  if (info.requestedChain !== inspection.chain || !Number.isFinite(info.checkedAt) || now < info.checkedAt
    || now - info.checkedAt > CHAIN_SNAPSHOT_TTL_MS) throw new Error('Chain maturity check is stale or belongs to another network.')
  const lock = getMetadataLockCondition(inspection.metadata)
  if (lock.kind === 'cltv_time') {
    if (!isCltvMature(info, lock.timestamp, inspection.chain, now)) throw new Error('This recovered fixed-date lock is not mature: chain MTP must be strictly after its target.')
  } else if (!Number.isSafeInteger(inspection.height) || inspection.height! <= 0 || !Number.isSafeInteger(info.blocks)
    || inspection.height! > info.blocks || info.blocks - inspection.height! + 1 < lock.blocks) {
    throw new Error('This recovered relative lock does not yet have the required confirmed block age.')
  }
}

function assetIdentity(inspection: RecoveryInspection): string {
  return JSON.stringify({ chain: inspection.chain, metadata: inspection.metadata, outpoint: inspection.outpoint,
    owner: inspection.ownerAddress, address: inspection.timeLockAddress, kind: inspection.assetKind, assets: inspection.assets })
}

function fundingIdentity(inputs: OpenApiUtxo[]): string {
  return JSON.stringify(inputs.map(({ txid, vout, satoshi, scriptPk }) => ({ txid, vout, satoshi, scriptPk })))
}

/** No wallet access or persistence is implicit; the controller supplies the shared gate and identity/CAS guard. */
export async function executeRecoveryUnlock(params: {
  reference: RecoveryReference; address: string; pubKey: string; chain: ChainType; feeRate: number
}, ports: RecoveryUnlockPorts): Promise<{ kind: 'cancelled' } | { kind: 'broadcast'; txid: string }> {
  let current = params.reference
  let preparedTxid: string | undefined
  let broadcastStarted = false
  const inspect = async () => {
    await ports.assertCurrent(current)
    const result = await ports.inspect(current)
    await ports.assertCurrent(current)
    if (result.chain !== current.chain || result.outpoint.txid !== current.txid || result.outpoint.vout !== current.vout
      || getMetadataLockCondition(result.metadata).kind !== current.lockKind) throw new Error('The recovered reference no longer matches the inspected lock.')
    assertRecoveryFresh(result)
    assertRecoveryOwner(result, params.address, params.pubKey, params.chain)
    return result
  }
  try {
    if (!Number.isFinite(params.feeRate) || params.feeRate <= 0) throw new Error('Enter a positive recovery fee rate.')
    ports.stage?.('Checking the original lock and its assets...')
    const original = await inspect()
    let info = await ports.chainInfo()
    await ports.assertCurrent(current)
    assertRecoveryMature(original, info)
    ports.stage?.('Checking a bounded set of fee inputs...')
    const feeUtxos = await ports.funding(original)
    await ports.assertCurrent(current)
    const transaction = buildTimeLockUnlockTx({ userAddress: params.address, pubKey: params.pubKey,
      lock: getMetadataLockCondition(original.metadata), inscriptionUtxo: original.outpoint, feeUtxos,
      feeRate: params.feeRate, chain: params.chain })
    const principal = transaction.outputs[0]
    if (!principal || principal.address !== original.ownerAddress || principal.satoshi !== original.outpoint.satoshi
      || transaction.outputs.some((output) => output.address !== original.ownerAddress)) throw new Error('Recovery outputs do not return the full principal and change to the original owner.')
    ports.stage?.('')
    const confirmed = await ports.confirm({ inspection: original, transaction, previousAttempt: current.unlockTxid })
    if (!confirmed) return { kind: 'cancelled' }

    const recheck = async () => {
      const latest = await inspect()
      if (assetIdentity(latest) !== assetIdentity(original)) throw new Error('Lock or asset information changed after review. Start a new review.')
      const checkedFees = await ports.verifyFunding(transaction.feeInputs, latest)
      await ports.assertCurrent(current)
      if (fundingIdentity(checkedFees) !== fundingIdentity(transaction.feeInputs)) throw new Error('Selected fee inputs changed after review.')
      info = await ports.chainInfo()
      await ports.assertCurrent(current)
      assertRecoveryMature(latest, info)
      return latest
    }
    const parsed = bitcoin.Psbt.fromHex(transaction.psbtHex)
    const inputs = toUniSatSignInputs(transaction.toSignInputs).map((input) => {
      const script = parsed.data.inputs[input.index].witnessUtxo?.script
      if (!script) throw new Error('Recovery input signing data is incomplete.')
      const taproot = script.length === 34 && script[0] === 0x51 && script[1] === 0x20
      const p2wpkh = script.length === 22 && script[0] === 0 && script[1] === 0x14
      if (!taproot && !p2wpkh) throw new Error('Unsupported recovery signing input.')
      return { ...input, sighashTypes: taproot ? [0, 1] : [1] }
    })
    const beforeSign = async () => {
      ports.stage?.('Rechecking lock, assets, fee inputs and maturity before signing...')
      await recheck()
      ports.stage?.('Review the recovered unlock in your wallet...')
    }
    const walletSigned = await ports.sign(transaction.psbtHex, { autoFinalized: true, toSignInputs: inputs }, beforeSign)
    const signedHex = assertSignedTransactionMatches(transaction.psbtHex, normalizeSignedPsbtToHex(walletSigned))
    preparedTxid = signedTxId(transaction.psbtHex, signedHex)
    ports.prepared?.(preparedTxid)
    ports.stage?.('Rechecking all inputs and maturity before broadcast...')
    const beforeBroadcast = await recheck()
    // Persist only the public attempt ID, not signed PSBTs or an assumed success state.
    current = ports.saveAttempt(current, preparedTxid)
    await ports.assertCurrent(current)
    assertRecoveryMature(beforeBroadcast, info)
    ports.stage?.('Requesting recovered unlock broadcast...')
    broadcastStarted = true
    const returned = await ports.broadcast(signedHex)
    if (typeof returned !== 'string' || returned.toLowerCase() !== preparedTxid) throw new Error('The wallet returned a different broadcast transaction ID. Submission is uncertain.')
    await ports.assertCurrent(current)
    return { kind: 'broadcast', txid: preparedTxid }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Recovery unlock failed.'
    throw new Error(`${message}${preparedTxid ? ` Prepared transaction ID: ${preparedTxid}. ${broadcastStarted ? 'A broadcast was requested; its outcome may be uncertain.' : 'No broadcast was requested by this operation.'} Check this transaction on the original network before any explicit retry.` : ''}`)
  }
}
