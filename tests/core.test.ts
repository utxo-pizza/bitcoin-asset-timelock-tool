import assert from 'node:assert/strict'
import test from 'node:test'
import { bitcoin } from '@unisat/wallet-bitcoin'
import { buildTimeLockUnlockTx, deriveTimeLockAddress, buildRuneTimeLockDeposit, buildSingleUtxoTimeLockDeposit, getUnsignedPsbtTxId } from '../src/lib/timelock'
import { buildTimeLockMetadataScript, decodeTimeLockMetadataScript, encodeRunestoneRecoveryMetadata, decodeRunestoneRecoveryMetadata, decodeRunestoneRecoveryMetadataScript, getMetadataLockCondition, deriveOwnerAddress, type TimeLockMetadata } from '../src/lib/recovery'
import { buildRuneTransferRunestone } from '../src/lib/runestone'
import { normalizeTimeLockCondition, resolveTimeLockCondition } from '../src/lib/lock-condition'
import { OwnerAddressType, type TimeLockCondition } from '../src/types'
import { csvGolden, pubKey, userAddress, utxo, readPsbt, runestoneValues } from './core/fixtures'

const v1: TimeLockMetadata = { version: 1, lockBlocks: 144, xOnlyPubKey: pubKey.slice(2), ownerAddressType: OwnerAddressType.P2WPKH_EVEN }
const timestamp = 2_208_988_800 // 2040-01-01T00:00:00Z, beyond signed 32-bit time.
const cltv: TimeLockCondition = { kind: 'cltv_time', timestamp }
const csv: TimeLockCondition = { kind: 'csv_blocks', blocks: 144 }
const v2: TimeLockMetadata = { version: 2, lockTime: timestamp, xOnlyPubKey: pubKey.slice(2), ownerAddressType: OwnerAddressType.P2WPKH_EVEN }
const brcParams = { userAddress, pubKey, ticker: 'test', amount: '123', fundingUtxo: utxo('33'), feeRate: 1 }
const runeParams = { userAddress, pubKey, runeId: '840000:1', runeName: 'TEST', runeAmount: '123', runeBalance: '500', hasUnallocatedRunes: true, runeUtxos: [utxo('44', 330)], feeUtxos: [utxo('55')], feeRate: 1 }

function unlock(lock: TimeLockCondition, satoshi = 546) {
  return buildTimeLockUnlockTx({ userAddress, pubKey, lock, inscriptionUtxo: { ...utxo('11', satoshi), scriptPk: '' }, feeUtxos: [utxo('22')], feeRate: 1 })
}

test('pre-change CSV addresses, script, control block and complete unlock PSBT are frozen', () => {
  for (const [blocks, address] of Object.entries(csvGolden.addresses)) {
    assert.equal(deriveTimeLockAddress(pubKey, Number(blocks)), address)
  }
  const result = buildTimeLockUnlockTx({ userAddress, pubKey, lockBlocks: 144, inscriptionUtxo: { ...utxo('11', 546), scriptPk: '' }, feeUtxos: [utxo('22')], feeRate: 1 })
  assert.equal(result.psbtHex, csvGolden.unlockPsbt)
  const psbt = readPsbt(result.psbtHex)
  const leaf = psbt.data.inputs[0].tapLeafScript![0]
  assert.equal(leaf.script.toString('hex'), csvGolden.leaf)
  assert.equal(leaf.controlBlock.toString('hex'), csvGolden.controlBlock)
  assert.equal(leaf.leafVersion, 0xc0)
  assert.equal(psbt.version, 2)
  assert.equal(psbt.locktime, 0)
  assert.equal(psbt.txInputs[0].sequence, 144)
})

test('pre-change BATL v1 bytes and decoded shape are frozen for both carriers', () => {
  const script = buildTimeLockMetadataScript(v1)
  assert.equal(script.toString('hex'), csvGolden.metadataScript)
  assert.deepEqual(decodeTimeLockMetadataScript(script), v1)
  const values = encodeRunestoneRecoveryMetadata(v1)
  assert.deepEqual(values.map(String), csvGolden.runestoneValues)
  assert.deepEqual(decodeRunestoneRecoveryMetadata(values), v1)
  const runestone = buildRuneTransferRunestone({ runeId: '840000:1', amount: '123', destinationOutput: 1, pointerOutput: 2, recoveryMetadata: v1 })
  assert.equal(runestone.toString('hex'), csvGolden.runestoneScript)
  assert.deepEqual(decodeRunestoneRecoveryMetadataScript(runestone), v1)
})

test('explicit CSV condition is byte-equivalent to the legacy builder arguments', () => {
  assert.equal(unlock(csv).psbtHex, csvGolden.unlockPsbt)
  assert.deepEqual(buildSingleUtxoTimeLockDeposit({ ...brcParams, lock: csv }), buildSingleUtxoTimeLockDeposit({ ...brcParams, lockBlocks: 144 }))
  assert.deepEqual(buildRuneTimeLockDeposit({ ...runeParams, lock: csv }), buildRuneTimeLockDeposit({ ...runeParams, lockBlocks: 144 }))
  for (const [blocks, address] of Object.entries(csvGolden.addresses)) {
    assert.equal(deriveTimeLockAddress(pubKey, { kind: 'csv_blocks', blocks: Number(blocks) }), address)
  }
})

test('lock validation is centralized and rejects invalid, ambiguous or missing conditions', () => {
  for (const value of [null, undefined, 144, {}, { kind: 'cltv_height', height: 840000 }, { kind: 'csv_time', seconds: 1000 }]) {
    assert.throws(() => normalizeTimeLockCondition(value))
  }
  for (const blocks of [0, -1, 65536, 1.5, NaN, Infinity, '144']) {
    assert.throws(() => normalizeTimeLockCondition({ kind: 'csv_blocks', blocks }))
  }
  for (const time of [0, 499_999_999, 0x1_0000_0000, 1.5, NaN, Infinity, String(timestamp), timestamp * 1000]) {
    assert.throws(() => normalizeTimeLockCondition({ kind: 'cltv_time', timestamp: time }))
  }
  assert.throws(() => normalizeTimeLockCondition({ ...csv, timestamp }))
  assert.throws(() => normalizeTimeLockCondition({ ...cltv, blocks: 144 }))
  assert.throws(() => resolveTimeLockCondition({}))
  assert.throws(() => resolveTimeLockCondition({ lock: cltv, lockBlocks: 144 }))
  assert.deepEqual(resolveTimeLockCondition({ lockBlocks: 144 }), csv)
  assert.deepEqual(normalizeTimeLockCondition(cltv), cltv)
  assert.notEqual(normalizeTimeLockCondition(cltv), cltv)
})

test('all exported builders reject missing and dual lock arguments before constructing a transaction', () => {
  const unlockParams = { userAddress, pubKey, inscriptionUtxo: utxo('11', 546), feeUtxos: [utxo('22')], feeRate: 1 }
  for (const lockArgs of [{}, { lock: cltv, lockBlocks: 144 }, { lock: { kind: 'cltv_height' } as unknown as TimeLockCondition }]) {
    assert.throws(() => buildSingleUtxoTimeLockDeposit({ ...brcParams, ...lockArgs }))
    assert.throws(() => buildRuneTimeLockDeposit({ ...runeParams, ...lockArgs }))
    assert.throws(() => buildTimeLockUnlockTx({ ...unlockParams, ...lockArgs }))
  }
})

test('new deposits exclude the final two uint32 targets without restricting raw recovery', () => {
  const lastCreatable = 0xffff_fffd
  for (const build of [
    (lock: TimeLockCondition) => buildSingleUtxoTimeLockDeposit({ ...brcParams, lock }),
    (lock: TimeLockCondition) => buildRuneTimeLockDeposit({ ...runeParams, lock }),
  ]) {
    assert.doesNotThrow(() => build({ kind: 'cltv_time', timestamp: lastCreatable }))
    for (const time of [lastCreatable + 1, lastCreatable + 2]) {
      assert.throws(() => build({ kind: 'cltv_time', timestamp: time }), /cannot confirm/)
    }
  }
  for (const time of [lastCreatable, lastCreatable + 1, lastCreatable + 2]) {
    assert.deepEqual(normalizeTimeLockCondition({ kind: 'cltv_time', timestamp: time }), { kind: 'cltv_time', timestamp: time })
    assert.ok(deriveTimeLockAddress(pubKey, { kind: 'cltv_time', timestamp: time }))
  }
})

test('CLTV address is deterministic and commits to the precise target and owner', () => {
  const expected = deriveTimeLockAddress(pubKey, cltv)
  assert.equal(deriveTimeLockAddress(pubKey, { ...cltv }), expected)
  assert.notEqual(deriveTimeLockAddress(pubKey, { kind: 'cltv_time', timestamp: timestamp + 1 }), expected)
  assert.notEqual(deriveTimeLockAddress(pubKey, csv), expected)
  const otherPublicKey = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
  assert.notEqual(deriveTimeLockAddress(otherPublicKey, cltv), expected)
  const originalNow = Date.now
  try {
    Date.now = () => 0
    assert.equal(deriveTimeLockAddress(pubKey, cltv), expected)
    Date.now = () => 9_000_000_000_000
    assert.equal(deriveTimeLockAddress(pubKey, cltv), expected)
  } finally { Date.now = originalNow }
})

for (const time of [500_000_000, 0x7fff_ffff, 0x8000_0000, timestamp, 0xffff_fffd, 0xffff_fffe, 0xffff_ffff]) {
  test(`CLTV ${time}: script number, uint32 nLockTime and non-final BIP68-disabled sequence`, () => {
    const result = unlock({ kind: 'cltv_time', timestamp: time })
    const psbt = readPsbt(result.psbtHex)
    assert.equal(psbt.version, 2)
    assert.equal(psbt.locktime, time)
    assert.equal(psbt.txInputs[0].sequence, 0xffff_fffe)
    assert.equal(psbt.txInputs[0].sequence! >>> 31, 1)
    assert.equal(psbt.txInputs[1].sequence, 0xffff_ffff)
    const leaf = psbt.data.inputs[0].tapLeafScript![0]
    const chunks = bitcoin.script.decompile(leaf.script)!
    assert.equal(chunks.length, 5)
    assert.ok(Buffer.isBuffer(chunks[0]))
    assert.equal(bitcoin.script.number.decode(chunks[0] as Buffer, 5), time)
    assert.equal((chunks[0] as Buffer).length, time >= 0x8000_0000 ? 5 : 4)
    if (time === 0xffff_ffff) assert.equal((chunks[0] as Buffer).toString('hex'), 'ffffffff00')
    assert.equal(chunks[1], bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY)
    assert.equal(chunks[2], bitcoin.opcodes.OP_DROP)
    assert.equal((chunks[3] as Buffer).toString('hex'), pubKey.slice(2))
    assert.equal(chunks[4], bitcoin.opcodes.OP_CHECKSIG)
    assert.equal(leaf.leafVersion, 0xc0)
    assert.equal(leaf.controlBlock.subarray(1).toString('hex'), csvGolden.controlBlock.slice(2))
    const committed = bitcoin.payments.p2tr({ internalPubkey: leaf.controlBlock.subarray(1), scriptTree: { output: leaf.script, version: leaf.leafVersion } })
    assert.equal(committed.address, deriveTimeLockAddress(pubKey, { kind: 'cltv_time', timestamp: time }))
    assert.deepEqual(committed.output, psbt.data.inputs[0].witnessUtxo!.script)
  })
}

test('unlock returns the entire 546/330-sat principal and pays fees only from separate inputs', () => {
  for (const condition of [csv, cltv]) {
    for (const principal of [546, 330]) {
      const result = unlock(condition, principal)
      const psbt = readPsbt(result.psbtHex)
      assert.equal(psbt.txOutputs[0].value, principal)
      assert.equal(result.outputs[0].satoshi, principal)
      assert.equal(result.outputs[0].address, userAddress)
      assert.equal(result.feeInputs.reduce((sum, input) => sum + input.satoshi, 0) - psbt.txOutputs.slice(1).reduce((sum, output) => sum + output.value, 0), result.estimatedFee)
      assert.throws(() => buildTimeLockUnlockTx({ userAddress, pubKey, lock: condition, inscriptionUtxo: { ...utxo('11', principal), scriptPk: '' }, feeUtxos: [], feeRate: 1 }))
    }
  }
  const csvOutput = readPsbt(unlock(csv).psbtHex).data.inputs[0].witnessUtxo!.script.toString('hex')
  assert.throws(() => buildTimeLockUnlockTx({ userAddress, pubKey, lock: cltv, inscriptionUtxo: { ...utxo('11', 546), scriptPk: csvOutput }, feeUtxos: [utxo('22')], feeRate: 1 }), /does not match/)
})

test('BATL v1/v2 round trips preserve each lock meaning and owner type in both carriers', () => {
  for (const ownerAddressType of [OwnerAddressType.P2TR, OwnerAddressType.P2WPKH_EVEN, OwnerAddressType.P2WPKH_ODD]) {
    const cases: TimeLockMetadata[] = [
      { ...v1, lockBlocks: 1, ownerAddressType }, { ...v1, lockBlocks: 65535, ownerAddressType },
      ...[500_000_000, timestamp, 0xffff_fffd, 0xffff_fffe, 0xffff_ffff].map(lockTime => ({ ...v2, lockTime, ownerAddressType })),
    ]
    for (const metadata of cases) {
      const marker = buildTimeLockMetadataScript(metadata)
      assert.deepEqual(decodeTimeLockMetadataScript(marker), metadata)
      assert.deepEqual(decodeTimeLockMetadataScript(marker.toString('hex')), metadata)
      assert.deepEqual(decodeRunestoneRecoveryMetadata(encodeRunestoneRecoveryMetadata(metadata)), metadata)
      const runestone = buildRuneTransferRunestone({ runeId: '840000:1', amount: '123', destinationOutput: 1, pointerOutput: 2, recoveryMetadata: metadata })
      assert.deepEqual(decodeRunestoneRecoveryMetadataScript(runestone), metadata)
      const chunks = bitcoin.script.decompile(marker)!
      assert.equal((chunks[3] as Buffer).length, metadata.version === 1 ? 2 : 4)
      if (metadata.version === 2) assert.equal((chunks[3] as Buffer).readUInt32BE(), metadata.lockTime)
    }
  }
  assert.deepEqual(getMetadataLockCondition(v1), csv)
  assert.deepEqual(getMetadataLockCondition(v2), cltv)
  assert.equal(deriveOwnerAddress(v1), userAddress)
  assert.equal(deriveOwnerAddress(v2), userAddress)
})

test('both metadata encoders reject unknown versions and malformed or cross-kind lock values', () => {
  const cases = [
    { ...v1, version: 3 }, { ...v2, version: 1 }, { ...v1, lockTime: timestamp }, { ...v2, lockBlocks: 144 },
    { ...v1, lockBlocks: 0 }, { ...v1, lockBlocks: 65536 }, { ...v2, lockTime: 499_999_999 },
    { ...v2, lockTime: 0x1_0000_0000 }, { ...v2, lockTime: 1.5 }, { ...v2, lockTime: String(timestamp) },
    { ...v2, ownerAddressType: 80 }, { ...v2, xOnlyPubKey: pubKey.slice(2) + 'zz' },
  ]
  for (const value of cases) {
    assert.throws(() => buildTimeLockMetadataScript(value as TimeLockMetadata))
    assert.throws(() => encodeRunestoneRecoveryMetadata(value as TimeLockMetadata))
  }
})

test('BRC metadata decoder rejects unsupported versions, malformed fields and partial hex', () => {
  const chunks = bitcoin.script.decompile(buildTimeLockMetadataScript(v2))!
  const variants = [chunks.slice(0, -1), [...chunks, bitcoin.opcodes.OP_0]]
  for (const [index, value] of [[2, bitcoin.opcodes.OP_3], [3, Buffer.alloc(2)], [3, Buffer.alloc(4)], [4, Buffer.alloc(31)], [5, Buffer.from([80])]] as const) {
    const changed = [...chunks]
    changed[index] = value
    variants.push(changed)
  }
  for (const variant of variants) assert.equal(decodeTimeLockMetadataScript(bitcoin.script.compile(variant)), undefined)
  for (const script of [buildTimeLockMetadataScript(v2).toString('hex') + 'zz', '6', 'zz', '6a4c']) {
    assert.equal(decodeTimeLockMetadataScript(script), undefined)
  }
})

test('Runestone decoder rejects malformed BATL groups, u128 overflow and fields after Tag.Body', () => {
  const values = encodeRunestoneRecoveryMetadata(v2)
  for (const [index, value] of [[3, 3n], [5, 499_999_999n], [5, 0x1_0000_0000n], [6, 129n], [7, -1n], [7, 1n << 128n], [9, -1n], [11, 80n]] as const) {
    const changed = [...values]
    changed[index] = value
    assert.equal(decodeRunestoneRecoveryMetadata(changed), undefined)
  }
  assert.equal(decodeRunestoneRecoveryMetadata(values.slice(0, -1)), undefined)
  assert.equal(decodeRunestoneRecoveryMetadata([0n, ...values]), undefined)
  const unknown = [...values]
  unknown[3] = 3n
  assert.equal(decodeRunestoneRecoveryMetadata([...unknown, ...encodeRunestoneRecoveryMetadata(v1)]), undefined)
  for (const payload of [Buffer.from([0x80]), Buffer.from([...Array(18).fill(0x80), 4]), Buffer.from([...Array(20).fill(0x80), 0])]) {
    assert.equal(decodeRunestoneRecoveryMetadataScript(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, bitcoin.opcodes.OP_13, payload])), undefined)
  }
  assert.equal(decodeRunestoneRecoveryMetadataScript(csvGolden.runestoneScript + 'zz'), undefined)
})

test('CLTV BRC deposit stays immediately serializable and preserves all five pre-signable outpoint links', () => {
  const result = buildSingleUtxoTimeLockDeposit({ ...brcParams, lock: cltv })
  assert.equal(result.steps.length, 5)
  const psbts = result.steps.map(step => readPsbt(step.psbtHex))
  const expectedLinks = [[{ txid: brcParams.fundingUtxo.txid, vout: 0 }], [{ txid: result.steps[0].txid, vout: 0 }], [{ txid: result.steps[1].txid, vout: 0 }, { txid: result.steps[1].txid, vout: 1 }], [{ txid: result.steps[2].txid, vout: 1 }], [{ txid: result.steps[3].txid, vout: 0 }]]
  psbts.forEach((psbt, index) => {
    assert.equal(psbt.locktime, 0, 'only locked outputs carry the future condition')
    assert.equal(psbt.version, 2)
    assert.deepEqual(psbt.txInputs.map(input => ({ txid: Buffer.from(input.hash).reverse().toString('hex'), vout: input.index })), expectedLinks[index])
    assert.ok(psbt.txInputs.every(input => input.sequence === 0xffff_ffff))
    assert.equal(getUnsignedPsbtTxId(result.steps[index].psbtHex), result.steps[index].txid)
    assert.equal(psbt.data.inputs.reduce((sum, input) => sum + input.witnessUtxo!.value, 0) - psbt.txOutputs.reduce((sum, output) => sum + output.value, 0), result.steps[index].estimatedFee)
  })
  assert.deepEqual(psbts[2].txOutputs[0].script, psbts[4].txOutputs[0].script)
  assert.equal(psbts[2].txOutputs[0].value, 546)
  assert.equal(psbts[4].txOutputs[0].value, 546)
  assert.equal(bitcoin.address.fromOutputScript(psbts[4].txOutputs[0].script), deriveTimeLockAddress(pubKey, cltv))
  assert.deepEqual(decodeTimeLockMetadataScript(psbts[4].txOutputs[1].script), v2)
  assert.equal(psbts[4].txOutputs[1].value, 0)
  assert.equal(psbts.flatMap(psbt => psbt.txOutputs).filter(output => output.script[0] === bitcoin.opcodes.OP_RETURN).length, 1)
  assert.equal(result.timeLockAddress, deriveTimeLockAddress(pubKey, cltv))
  assert.equal(result.totalEstimatedFee, result.steps.reduce((sum, step) => sum + step.estimatedFee, 0))
})

test('Rune CLTV preserves one Runestone, edict to output 1 and 330-sat change/pointer at output 2', () => {
  for (const lock of [csv, cltv]) {
    const result = buildRuneTimeLockDeposit({ ...runeParams, lock })
    const psbt = readPsbt(result.psbtHex)
    assert.equal(psbt.locktime, 0)
    assert.equal(psbt.txOutputs[0].value, 0)
    assert.equal(psbt.txOutputs.filter(output => output.script[0] === bitcoin.opcodes.OP_RETURN).length, 1)
    assert.equal(psbt.txOutputs[1].value, 330)
    assert.equal(psbt.txOutputs[2].value, 330)
    assert.equal(bitcoin.address.fromOutputScript(psbt.txOutputs[1].script), deriveTimeLockAddress(pubKey, lock))
    assert.equal(bitcoin.address.fromOutputScript(psbt.txOutputs[2].script), userAddress)
    assert.deepEqual(decodeRunestoneRecoveryMetadataScript(psbt.txOutputs[0].script), lock.kind === 'csv_blocks' ? v1 : v2)
    assert.deepEqual(runestoneValues(psbt.txOutputs[0].script).slice(12), [22n, 2n, 0n, 840000n, 1n, 123n, 1n])
    assert.equal(result.inputs.reduce((sum, input) => sum + input.satoshi, 0) - result.outputs.reduce((sum, output) => sum + output.satoshi, 0), result.estimatedFee)
  }
  const noChange = buildRuneTimeLockDeposit({ ...runeParams, lock: cltv, runeBalance: '123', hasUnallocatedRunes: false })
  assert.equal(noChange.outputs.some(output => output.type === 'rune_change'), false)
  assert.deepEqual(runestoneValues(readPsbt(noChange.psbtHex).txOutputs[0].script).slice(12), [0n, 840000n, 1n, 123n, 1n])
})
