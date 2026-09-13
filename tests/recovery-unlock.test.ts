import assert from 'node:assert/strict'
import test from 'node:test'
import { bitcoin, eccManager } from '@unisat/wallet-bitcoin'
import { ChainType, OwnerAddressType, type OpenApiUtxo } from '../src/types'
import { deriveTimeLockAddress } from '../src/lib/timelock'
import { getMetadataLockCondition, type TimeLockMetadata } from '../src/lib/recovery'
import type { RecoveryInspection } from '../src/lib/recovery-chain'
import type { RecoveryReference } from '../src/lib/recovered-records'
import type { BlockchainInfo } from '../src/lib/openapi'
import { assertRecoveryMature, executeRecoveryUnlock, type RecoveryUnlockPorts, type RecoveryUnlockReview } from '../src/lib/recovery-unlock'
import { pubKey, userAddress, scriptPk } from './core/fixtures'

// Publicly known TEST-ONLY scalar 1. All outpoints and signatures are synthetic.
const signer = eccManager.eccPair.fromPrivateKey(Buffer.from('00'.repeat(31) + '01', 'hex'))

function fixture(kind: 'csv_blocks' | 'cltv_time' = 'csv_blocks') {
  const chain = ChainType.BITCOIN_MAINNET
  const metadata: TimeLockMetadata = kind === 'csv_blocks'
    ? { version: 1, lockBlocks: 3, xOnlyPubKey: pubKey.slice(2), ownerAddressType: OwnerAddressType.P2WPKH_EVEN }
    : { version: 2, lockTime: 2_208_988_800, xOnlyPubKey: pubKey.slice(2), ownerAddressType: OwnerAddressType.P2WPKH_EVEN }
  const address = deriveTimeLockAddress(pubKey, getMetadataLockCondition(metadata), chain)
  const reference: RecoveryReference = { schemaVersion: 1, chain, txid: '11'.repeat(32), vout: 0, lockKind: kind, source: 'txid', restoredAt: 1 }
  const inspection: RecoveryInspection = { chain, metadata, ownerAddress: userAddress, timeLockAddress: address, assetKind: 'brc20',
    outpoint: { txid: reference.txid, vout: 0, satoshi: 546, scriptPk: bitcoin.address.toOutputScript(address).toString('hex') },
    verification: 'verified', assets: { kind: 'brc20', inscriptionId: `${reference.txid}i0`, ticker: 'test', amount: '10', decimal: 0 },
    height: 490, confirmations: 11, checkedAt: Date.now() }
  const info: BlockchainInfo = { requestedChain: chain, blocks: 500, headers: 500, medianTime: 2_208_988_801,
    bestBlockHash: '33'.repeat(32), prevBlockHash: '44'.repeat(32), checkedAt: Date.now() }
  const fee: OpenApiUtxo = { txid: '22'.repeat(32), vout: 0, satoshi: 20_000, scriptPk, address: userAddress, height: 480, isSpent: false }
  const state = { signCalls: 0, broadcastCalls: 0, inspections: 0, feeChecks: 0, guardCalls: 0, confirmCalls: 0,
    current: { ...reference }, accept: true, invalidContext: false, changeAfterSign: false, changeAfterBroadcast: false,
    mutateSigned: false, saveFailure: false, broadcastFailure: false, wrongBroadcastId: false,
    inspectionChangeAt: 0, feeChange: false, prepared: '', broadcast: '', review: undefined as RecoveryUnlockReview | undefined }
  const ports: RecoveryUnlockPorts = {
    assertCurrent: async (expected) => { state.guardCalls++; if (state.invalidContext) throw new Error('Synthetic context changed'); assert.deepEqual(expected, state.current) },
    inspect: async () => {
      state.inspections++
      return { ...inspection, ...(state.inspectionChangeAt === state.inspections ? { verification: 'unknown' as const } : {}) }
    },
    funding: async () => [fee],
    verifyFunding: async (selected) => { state.feeChecks++; return selected.map((input) => ({ ...input, satoshi: input.satoshi + (state.feeChange ? 1 : 0) })) },
    chainInfo: async () => info,
    confirm: async (review) => { state.confirmCalls++; state.review = review; return state.accept },
    sign: async (hex, options, beforeSign) => {
      await beforeSign(); state.signCalls++
      assert.equal(options.autoFinalized, true)
      assert.deepEqual(options.toSignInputs.map((input) => input.sighashTypes), [[0, 1], [1]])
      let psbt = bitcoin.Psbt.fromHex(hex)
      if (state.mutateSigned) {
        const changed = new bitcoin.Psbt().setVersion(psbt.version).setLocktime(psbt.locktime)
        psbt.txInputs.forEach((input, index) => changed.addInput({ ...input, ...psbt.data.inputs[index] }))
        psbt.txOutputs.forEach((output, index) => changed.addOutput({ script: output.script, value: output.value - (index === 0 ? 1 : 0) }))
        psbt = changed
      }
      psbt.signInput(0, signer).signInput(1, signer).finalizeAllInputs()
      if (state.changeAfterSign) state.invalidContext = true
      return psbt.toHex()
    },
    saveAttempt: (expected, txid) => { assert.deepEqual(expected, state.current); if (state.saveFailure) throw new Error('Synthetic storage quota failure'); state.current = { ...expected, unlockTxid: txid }; return state.current },
    prepared: (txid) => { state.prepared = txid },
    broadcast: async (hex) => {
      state.broadcastCalls++; state.broadcast = hex
      assert.ok(state.current.unlockTxid, 'attempt must be stored before broadcast')
      if (state.broadcastFailure) throw new Error('Synthetic transport interruption')
      if (state.changeAfterBroadcast) state.invalidContext = true
      return state.wrongBroadcastId ? 'ff'.repeat(32) : bitcoin.Psbt.fromHex(hex).extractTransaction().getId()
    },
  }
  return { reference, inspection, info, fee, state, ports,
    run: () => executeRecoveryUnlock({ reference, address: userAddress, pubKey, chain, feeRate: 1 }, ports) }
}

for (const kind of ['csv_blocks', 'cltv_time'] as const) {
  test(`recovered ${kind} unlock verifies before and after signing and returns all principal`, async () => {
    const f = fixture(kind)
    const result = await f.run()
    assert.equal(result.kind, 'broadcast')
    assert.equal(f.state.signCalls, 1)
    assert.equal(f.state.broadcastCalls, 1)
    assert.equal(f.state.inspections, 3)
    assert.equal(f.state.feeChecks, 2)
    const tx = bitcoin.Psbt.fromHex(f.state.broadcast).extractTransaction()
    assert.equal(tx.outs[0].value, 546)
    assert.ok(tx.outs.every((output) => output.script.toString('hex') === scriptPk))
    assert.equal(tx.locktime, kind === 'csv_blocks' ? 0 : 2_208_988_800)
    assert.equal(tx.ins[0].sequence, kind === 'csv_blocks' ? 3 : 0xfffffffe)
    assert.equal(f.state.current.unlockTxid, tx.getId())
    assert.equal(JSON.stringify(f.state.current).includes('70736274'), false)
  })
}

test('recovery review cancellation requests neither signature nor broadcast', async () => {
  const f = fixture(); f.state.accept = false
  assert.deepEqual(await f.run(), { kind: 'cancelled' })
  assert.equal(f.state.signCalls, 0); assert.equal(f.state.broadcastCalls, 0)
  assert.equal(f.state.current.unlockTxid, undefined)
})

test('recovery rejects unverified, spent, wrong-owner and wrong-network inspections before signing', async () => {
  for (const change of ['unknown', 'spent', 'owner', 'chain'] as const) {
    const f = fixture()
    if (change === 'unknown' || change === 'spent') f.inspection.verification = change
    else if (change === 'owner') f.inspection.ownerAddress = 'bc1qsyntheticwrongowner'
    else f.inspection.chain = ChainType.FRACTAL_BITCOIN_MAINNET
    await assert.rejects(f.run())
    assert.equal(f.state.signCalls, 0); assert.equal(f.state.broadcastCalls, 0)
  }
})

test('recovery maturity requires confirmed CSV age and strict CLTV MTP greater-than', async () => {
  const csv = fixture(); csv.info.blocks = 491
  await assert.rejects(csv.run(), /block age/)
  assert.equal(csv.state.signCalls, 0)
  const cltv = fixture('cltv_time'); cltv.info.medianTime = 2_208_988_800
  await assert.rejects(cltv.run(), /strictly after/)
  assert.equal(cltv.state.signCalls, 0)
  for (const variant of ['stale', 'chain', 'height'] as const) {
    const f = fixture()
    if (variant === 'stale') f.info.checkedAt -= 60_001
    else if (variant === 'chain') f.info.requestedChain = ChainType.BITCOIN_SIGNET
    else f.inspection.height = undefined
    assert.throws(() => assertRecoveryMature(f.inspection, f.info))
  }
})

test('freshness/asset and selected-funding changes stop signing or broadcast', async () => {
  for (const inspectionChangeAt of [2, 3]) {
    const f = fixture(); f.state.inspectionChangeAt = inspectionChangeAt
    await assert.rejects(f.run(), /not verified/)
    assert.equal(f.state.signCalls, inspectionChangeAt === 2 ? 0 : 1)
    assert.equal(f.state.broadcastCalls, 0)
  }
  const f = fixture(); f.state.feeChange = true
  await assert.rejects(f.run(), /fee inputs changed/)
  assert.equal(f.state.signCalls, 0)
})

test('wallet or API context changes after signing stop broadcast and retain the prepared ID in feedback', async () => {
  const f = fixture(); f.state.changeAfterSign = true
  await assert.rejects(f.run(), (error: unknown) => {
    assert.ok(error instanceof Error && error.message.includes('context changed') && error.message.includes(f.state.prepared))
    return true
  })
  assert.equal(f.state.signCalls, 1); assert.equal(f.state.broadcastCalls, 0)
})

test('wallet output changes fail signed-transaction validation before persistence or broadcast', async () => {
  const f = fixture(); f.state.mutateSigned = true
  await assert.rejects(f.run(), /unsigned transaction/)
  assert.equal(f.state.broadcastCalls, 0); assert.equal(f.state.current.unlockTxid, undefined)
})

test('attempt persistence failure prevents broadcast; uncertain broadcast retains public attempt', async () => {
  const storage = fixture(); storage.state.saveFailure = true
  await assert.rejects(storage.run(), /storage quota failure.*Prepared transaction ID/)
  assert.equal(storage.state.broadcastCalls, 0)
  for (const change of ['broadcastFailure', 'wrongBroadcastId', 'changeAfterBroadcast'] as const) {
    const f = fixture(); f.state[change] = true
    await assert.rejects(f.run(), /Prepared transaction ID/)
    assert.equal(f.state.broadcastCalls, 1)
    assert.equal(f.state.current.unlockTxid, f.state.prepared)
  }
})

test('a maturity snapshot that expires during the final identity check cannot be broadcast', async () => {
  const f = fixture()
  const check = f.ports.assertCurrent
  f.ports.assertCurrent = async (reference) => {
    await check(reference)
    if (reference.unlockTxid) f.info.checkedAt = Date.now() - 60_001
  }
  await assert.rejects(f.run(), /stale.*Prepared transaction ID/)
  assert.equal(f.state.signCalls, 1); assert.equal(f.state.broadcastCalls, 0)
  assert.equal(f.state.current.unlockTxid, f.state.prepared)
})

test('explicit retry always reviews the previous attempt and never auto-resumes a signed chain', async () => {
  const f = fixture(); f.reference.unlockTxid = 'aa'.repeat(32); f.state.current = { ...f.reference }
  f.state.accept = false
  assert.deepEqual(await f.run(), { kind: 'cancelled' })
  assert.equal(f.state.review?.previousAttempt, 'aa'.repeat(32))
  assert.equal(f.state.confirmCalls, 1); assert.equal(f.state.signCalls, 0)
})
