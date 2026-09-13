import assert from 'node:assert/strict'
import test from 'node:test'
import { bitcoin, eccManager, toXOnly, tweakSigner } from '@unisat/wallet-bitcoin'
import { Buffer } from 'buffer'
import { ChainType } from '../src/types'
import { MAX_PUBLIC_RECOVERY_BYTES, MAX_PUBLIC_RECOVERY_OUTPOINTS, parsePublicRecoveryManifest, serializePublicRecoveryManifest, type PublicRecoveryManifest } from '../src/lib/recovery-manifest'
import { assertSignedTransactionMatches, signedTxId } from '../src/lib/signed-transaction'
import { csvGolden } from './core/fixtures'

// TEST-ONLY scalar 1 (public generator G), synthetic outpoints, and no network I/O.
// This deliberately known key must never be used by an actual wallet or funded.
const syntheticSigner = eccManager.eccPair.fromPrivateKey(Buffer.from(`${'00'.repeat(31)}01`, 'hex'))
const xOnly = toXOnly(syntheticSigner.publicKey)
const walletPayment = bitcoin.payments.p2wpkh({ pubkey: syntheticSigner.publicKey })
const internalKey = Buffer.from('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0', 'hex')
type SpendMode = 'p2wpkh' | 'keypath' | 'scriptpath'

function manifest(): PublicRecoveryManifest {
  return { format: 'batl-recovery', version: 1, chain: ChainType.FRACTAL_BITCOIN_MAINNET, outpoints: [{ txid: 'ab'.repeat(32), vout: 0 }] }
}

function createPsbt(mode: SpendMode, sighashType?: number, leafScript?: Buffer): bitcoin.Psbt {
  const psbt = new bitcoin.Psbt().setVersion(2).setLocktime(600_000_000)
  const common = { hash: '11'.repeat(32), index: 0, sequence: 0xfffffffd, ...(sighashType === undefined ? {} : { sighashType }) }
  if (mode === 'p2wpkh') psbt.addInput({ ...common, witnessUtxo: { script: walletPayment.output!, value: 30_000 } })
  else if (mode === 'keypath') {
    const payment = bitcoin.payments.p2tr({ internalPubkey: xOnly })
    psbt.addInput({ ...common, witnessUtxo: { script: payment.output!, value: 30_000 }, tapInternalKey: xOnly })
  } else {
    const script = leafScript ?? bitcoin.script.compile([xOnly, bitcoin.opcodes.OP_CHECKSIG])
    const payment = bitcoin.payments.p2tr({ internalPubkey: internalKey, scriptTree: { output: script }, redeem: { output: script, redeemVersion: 0xc0 } })
    psbt.addInput({ ...common, witnessUtxo: { script: payment.output!, value: 30_000 }, tapInternalKey: internalKey,
      tapLeafScript: [{ leafVersion: 0xc0, script, controlBlock: payment.witness![payment.witness!.length - 1] }] })
  }
  psbt.addOutput({ script: walletPayment.output!, value: 25_000 })
  return psbt
}

function sign(psbt: bitcoin.Psbt, mode: SpendMode, sighashType?: number): bitcoin.Psbt {
  const signed = psbt.clone()
  signed.signInput(0, mode === 'keypath' ? tweakSigner(syntheticSigner) : syntheticSigner,
    sighashType === undefined ? undefined : [sighashType])
  return signed.finalizeAllInputs()
}

function witnessBytes(witness: Buffer[]): Buffer {
  const size = (value: number) => {
    if (value < 0xfd) return Buffer.from([value])
    assert.ok(value <= 0xffff)
    const encoded = Buffer.alloc(3)
    encoded[0] = 0xfd
    encoded.writeUInt16LE(value, 1)
    return encoded
  }
  return Buffer.concat([size(witness.length), ...witness.flatMap((item) => [size(item.length), item])])
}

function changeWitness(signed: bitcoin.Psbt, update: (witness: Buffer[]) => Buffer[]): string {
  const witness = signed.extractTransaction().ins[0].witness.map((item) => Buffer.from(item))
  signed.data.inputs[0].finalScriptWitness = witnessBytes(update(witness))
  return signed.toHex()
}

test('public manifest has deterministic public-only JSON and normalizes txid case', () => {
  const value = manifest()
  value.outpoints[0].txid = value.outpoints[0].txid.toUpperCase()
  const serialized = serializePublicRecoveryManifest(value)
  assert.equal(serialized, `{"format":"batl-recovery","version":1,"chain":"FRACTAL_BITCOIN_MAINNET","outpoints":[{"txid":"${'ab'.repeat(32)}","vout":0}]}`)
  assert.equal(parsePublicRecoveryManifest(serialized).outpoints[0].txid, 'ab'.repeat(32))
  assert.notEqual(parsePublicRecoveryManifest(serialized), value)
  for (const chain of Object.values(ChainType)) {
    assert.equal(parsePublicRecoveryManifest(serializePublicRecoveryManifest({ ...manifest(), chain })).chain, chain)
  }
})

test('manifest rejects extra application or secret fields on either boundary', () => {
  for (const key of ['apiKey', 'privateKey', 'pendingPsbts', 'ownerAddress', 'nonce', 'amount', 'url', 'html', 'unexpected']) {
    const value = { ...manifest(), [key]: 'synthetic-only' }
    assert.throws(() => serializePublicRecoveryManifest(value), /fields/)
    assert.throws(() => parsePublicRecoveryManifest(JSON.stringify(value)), /fields/)
    const nested = { ...manifest(), outpoints: [{ ...manifest().outpoints[0], [key]: 'synthetic-only' }] }
    assert.throws(() => serializePublicRecoveryManifest(nested), /fields/)
    assert.throws(() => parsePublicRecoveryManifest(JSON.stringify(nested)), /fields/)
  }
})

test('manifest rejects unsupported format/version/chain, malformed data, and incomplete fields', () => {
  for (const value of [null, [], {}, { ...manifest(), format: 'other' }, { ...manifest(), version: 2 },
    { ...manifest(), chain: 'unknown' }, { ...manifest(), chain: 1 }, { ...manifest(), outpoints: null }]) {
    assert.throws(() => serializePublicRecoveryManifest(value))
    assert.throws(() => parsePublicRecoveryManifest(JSON.stringify(value)))
  }
  assert.throws(() => parsePublicRecoveryManifest('<html>not a manifest</html>'), /JSON/)
})

test('manifest outpoints have exact uint32 bounds and case-insensitive duplicate rejection', () => {
  for (const vout of [-1, 0.5, 0x100000000, NaN, Infinity, '0']) {
    assert.throws(() => serializePublicRecoveryManifest({ ...manifest(), outpoints: [{ txid: 'ab'.repeat(32), vout }] }), /outpoint/)
  }
  for (const txid of ['', 'ab'.repeat(31), 'ag'.repeat(32), ' ab'.repeat(32), 42]) {
    assert.throws(() => serializePublicRecoveryManifest({ ...manifest(), outpoints: [{ txid, vout: 0 }] }), /outpoint/)
  }
  for (const vout of [0, 0xffffffff]) assert.equal(parsePublicRecoveryManifest(serializePublicRecoveryManifest({ ...manifest(), outpoints: [{ txid: 'ab'.repeat(32), vout }] })).outpoints[0].vout, vout)
  const duplicate = { ...manifest(), outpoints: [{ txid: 'ab'.repeat(32), vout: 0 }, { txid: 'AB'.repeat(32), vout: 0 }] }
  assert.throws(() => serializePublicRecoveryManifest(duplicate), /duplicate/)
  assert.throws(() => parsePublicRecoveryManifest(JSON.stringify(duplicate)), /duplicate/)
})

test('manifest enforces array and UTF-8 content limits before parsing', () => {
  const outpoints = Array.from({ length: MAX_PUBLIC_RECOVERY_OUTPOINTS }, (_, vout) => ({ txid: 'ab'.repeat(32), vout }))
  const value = { ...manifest(), outpoints }
  assert.equal(parsePublicRecoveryManifest(serializePublicRecoveryManifest(value)).outpoints.length, 20)
  assert.throws(() => serializePublicRecoveryManifest({ ...value, outpoints: [] }), /1–20/)
  assert.throws(() => serializePublicRecoveryManifest({ ...value, outpoints: [...outpoints, { txid: 'cd'.repeat(32), vout: 0 }] }), /1–20/)
  const content = serializePublicRecoveryManifest(manifest())
  assert.deepEqual(parsePublicRecoveryManifest(content.padEnd(MAX_PUBLIC_RECOVERY_BYTES, ' ')), manifest())
  assert.throws(() => parsePublicRecoveryManifest(content.padEnd(MAX_PUBLIC_RECOVERY_BYTES + 1, ' ')), /UTF-8/)
  const multibyte = `{"note":"${'中'.repeat(1400)}"}`
  assert.ok(multibyte.length < MAX_PUBLIC_RECOVERY_BYTES)
  assert.throws(() => parsePublicRecoveryManifest(multibyte), /UTF-8/)
})

test('manifest serialization does not invoke getters, toJSON, or custom array iterators', () => {
  const getter = { ...manifest() }
  Object.defineProperty(getter, 'chain', { enumerable: true, get: () => assert.fail('getter must not run') })
  assert.throws(() => serializePublicRecoveryManifest(getter), /non-data/)
  const customJson = { ...manifest(), toJSON: () => assert.fail('toJSON must not run') }
  assert.throws(() => serializePublicRecoveryManifest(customJson), /fields/)
  const entries = manifest().outpoints
  Object.defineProperty(entries, Symbol.iterator, { value: () => assert.fail('iterator must not run') })
  assert.throws(() => serializePublicRecoveryManifest({ ...manifest(), outpoints: entries }), /array/)
  assert.throws(() => parsePublicRecoveryManifest('{"__proto__":{},"format":"batl-recovery","version":1,"chain":"BITCOIN_MAINNET","outpoints":[]}'), /fields/)
})

for (const mode of ['p2wpkh', 'keypath', 'scriptpath'] as const) {
  test(`signed guard verifies finalized synthetic ${mode} and derives the correct txid`, () => {
    const expected = createPsbt(mode)
    const signed = sign(expected, mode)
    assert.equal(assertSignedTransactionMatches(expected.toHex(), signed.toHex()), signed.toHex())
    assert.equal(signedTxId(expected.toHex(), signed.toHex()), signed.extractTransaction().getId())
  })

  test(`signed guard accepts explicit ALL for ${mode}`, () => {
    const expected = createPsbt(mode, bitcoin.Transaction.SIGHASH_ALL)
    const signed = sign(expected, mode, bitcoin.Transaction.SIGHASH_ALL)
    assert.equal(assertSignedTransactionMatches(expected.toHex(), signed.toHex()), signed.toHex())
  })

  test(`signed guard rejects missing finalization and invalid signatures for ${mode}`, () => {
    const expected = createPsbt(mode)
    const unfinished = expected.clone().signInput(0, mode === 'keypath' ? tweakSigner(syntheticSigner) : syntheticSigner)
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), unfinished.toHex()), /finalized/)
    const invalid = changeWitness(sign(expected, mode), (witness) => { witness[0][10] ^= 1; return witness })
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), invalid), /invalid/)
  })

  test(`signed guard rejects weaker synthetic signature hash types for ${mode}`, () => {
    for (const type of [bitcoin.Transaction.SIGHASH_NONE, bitcoin.Transaction.SIGHASH_SINGLE,
      bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_ANYONECANPAY]) {
      const expected = createPsbt(mode, type)
      const signed = sign(expected, mode, type)
      assert.throws(() => assertSignedTransactionMatches(expected.toHex(), signed.toHex()), /SIGHASH|DEFAULT/)
    }
  })
}

test('signed guard rejects any change to destination, value, input, version, sequence, or locktime', () => {
  const expected = createPsbt('p2wpkh')
  const alternativePayment = bitcoin.payments.p2tr({ internalPubkey: xOnly })
  const changes: ((psbt: bitcoin.Psbt) => void)[] = [
    (psbt) => { psbt.setVersion(1) },
    (psbt) => { psbt.setLocktime(600_000_001) },
    (psbt) => { psbt.setInputSequence(0, 0xfffffffc) },
  ]
  for (const change of changes) {
    const changed = expected.clone()
    change(changed)
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), sign(changed, 'p2wpkh').toHex()), /unsigned transaction/)
  }
  for (const variant of ['address', 'value', 'outpoint', 'index', 'extra-output'] as const) {
    const changed = new bitcoin.Psbt().setVersion(expected.version).setLocktime(expected.locktime)
    changed.addInput({ hash: (variant === 'outpoint' ? '22' : '11').repeat(32), index: variant === 'index' ? 1 : 0,
      sequence: 0xfffffffd, witnessUtxo: { script: walletPayment.output!, value: 30_000 } })
    changed.addOutput({ script: variant === 'address' ? alternativePayment.output! : walletPayment.output!, value: variant === 'value' ? 24_999 : 25_000 })
    if (variant === 'extra-output') changed.addOutput({ script: walletPayment.output!, value: 546 })
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), sign(changed, 'p2wpkh').toHex()), /unsigned transaction/)
  }
})

test('signed guard rejects changed, absent, or added previous-output signing data', () => {
  const expected = createPsbt('p2wpkh')
  for (const variant of ['value', 'script', 'missing', 'nonWitness'] as const) {
    const signed = sign(expected, 'p2wpkh')
    const input = signed.data.inputs[0]
    if (variant === 'value') input.witnessUtxo!.value += 1
    else if (variant === 'script') input.witnessUtxo!.script = bitcoin.payments.p2tr({ internalPubkey: xOnly }).output!
    else if (variant === 'missing') delete input.witnessUtxo
    else input.nonWitnessUtxo = bitcoin.Transaction.fromBuffer(expected.data.globalMap.unsignedTx.toBuffer()).toBuffer()
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), signed.toHex()), /UTXO|previous-transaction|unsupported/)
  }
})

test('signed guard rejects an unrelated P2WPKH public key and malformed DER', () => {
  const expected = createPsbt('p2wpkh')
  const otherPublicKey = Buffer.from('02c6047f9441ed7d6d3045406e95c07cd85aeb8f4c708e8a5e39f1125d876be916', 'hex')
  const wrongKey = changeWitness(sign(expected, 'p2wpkh'), (witness) => [witness[0], otherPublicKey])
  assert.throws(() => assertSignedTransactionMatches(expected.toHex(), wrongKey), /public key/)
  const malformed = changeWitness(sign(expected, 'p2wpkh'), (witness) => [Buffer.from([0x30, 0x00, 0x01]), witness[1]])
  assert.throws(() => assertSignedTransactionMatches(expected.toHex(), malformed), /invalid/)
})

test('signed guard rejects Taproot leaf/control changes, extra witness stack, and annex', () => {
  for (const mode of ['keypath', 'scriptpath'] as const) {
    const expected = createPsbt(mode)
    const extra = changeWitness(sign(expected, mode), (witness) => [...witness, Buffer.from([0x50])])
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), extra), /path|stack|annex/)
    const explicitDefault = changeWitness(sign(expected, mode), (witness) => [Buffer.concat([witness[0], Buffer.from([0])]), ...witness.slice(1)])
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), explicitDefault), /DEFAULT/)
  }
  for (const item of [1, 2]) {
    const expected = createPsbt('scriptpath')
    const changed = changeWitness(sign(expected, 'scriptpath'), (witness) => { witness[item][1] ^= 1; return witness })
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), changed), /script or control block/)
  }
})

test('signed guard rejects trailing or noncanonical witness serialization and nonempty scriptSig', () => {
  const expected = createPsbt('keypath')
  for (const variant of ['trailing', 'noncanonical', 'scriptSig'] as const) {
    const signed = sign(expected, 'keypath')
    const input = signed.data.inputs[0]
    if (variant === 'trailing') input.finalScriptWitness = Buffer.concat([input.finalScriptWitness!, Buffer.from([0])])
    else if (variant === 'noncanonical') input.finalScriptWitness = Buffer.concat([Buffer.from([0xfd, 1, 0]), input.finalScriptWitness!.subarray(1)])
    else input.finalScriptSig = Buffer.from([bitcoin.opcodes.OP_0])
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), signed.toHex()), /trailing|canonical|scriptSig/)
  }
})

test('signed guard accepts the unchanged CSV golden transaction with both inputs finalized', () => {
  const expected = bitcoin.Psbt.fromHex(csvGolden.unlockPsbt)
  const signed = expected.clone().signInput(0, syntheticSigner).signInput(1, syntheticSigner).finalizeAllInputs()
  assert.equal(assertSignedTransactionMatches(expected.toHex(), signed.toHex()), signed.toHex())
  const incomplete = bitcoin.Psbt.fromHex(signed.toHex())
  delete incomplete.data.inputs[1].finalScriptWitness
  assert.throws(() => assertSignedTransactionMatches(expected.toHex(), incomplete.toHex()), /finalized/)
  assert.equal(expected.toHex(), csvGolden.unlockPsbt)
})

test('signed guard supports a public JSON inscription leaf with a multi-byte script length', () => {
  const content = serializePublicRecoveryManifest({ ...manifest(), outpoints: Array.from({ length: 4 }, (_, vout) => ({ txid: 'ab'.repeat(32), vout })) })
  const leaf = bitcoin.script.compile([xOnly, bitcoin.opcodes.OP_CHECKSIG, bitcoin.opcodes.OP_0, bitcoin.opcodes.OP_IF,
    Buffer.from('ord'), bitcoin.opcodes.OP_1, Buffer.from('application/json'), bitcoin.opcodes.OP_0, Buffer.from(content), bitcoin.opcodes.OP_ENDIF])
  assert.ok(leaf.length > 0xfd)
  const expected = createPsbt('scriptpath', undefined, leaf)
  const signed = sign(expected, 'scriptpath')
  assert.equal(assertSignedTransactionMatches(expected.toHex(), signed.toHex()), signed.toHex())
})

test('signed guard preserves a post-2038 CLTV leaf and absolute locktime', () => {
  const timestamp = 2_208_988_800
  const leaf = bitcoin.script.compile([bitcoin.script.number.encode(timestamp), bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
    bitcoin.opcodes.OP_DROP, xOnly, bitcoin.opcodes.OP_CHECKSIG])
  const expected = createPsbt('scriptpath', undefined, leaf).setLocktime(timestamp)
  const signed = sign(expected, 'scriptpath')
  assert.equal(assertSignedTransactionMatches(expected.toHex(), signed.toHex()), signed.toHex())
  assert.equal(signed.extractTransaction().locktime, timestamp)
})

test('signed guard verifies mixed Taproot/P2WPKH inputs and rejects a missing input', () => {
  const expected = createPsbt('keypath')
  expected.addInput({ hash: '22'.repeat(32), index: 0, witnessUtxo: { script: walletPayment.output!, value: 1000 } })
  const signed = expected.clone().signInput(0, tweakSigner(syntheticSigner)).signInput(1, syntheticSigner).finalizeAllInputs()
  assert.equal(assertSignedTransactionMatches(expected.toHex(), signed.toHex()), signed.toHex())
  const missing = sign(createPsbt('keypath'), 'keypath')
  assert.throws(() => assertSignedTransactionMatches(expected.toHex(), missing.toHex()), /unsigned transaction/)
})

test('signed guard rejects signing-mode changes and inconsistent retained signing metadata', () => {
  const expected = createPsbt('scriptpath')
  const signed = sign(expected, 'scriptpath')
  const missingLeaf = expected.clone()
  delete missingLeaf.data.inputs[0].tapLeafScript
  assert.throws(() => assertSignedTransactionMatches(missingLeaf.toHex(), signed.toHex()), /key path/)
  const secondLeaf = expected.clone()
  const differentControlBlock = Buffer.from(secondLeaf.data.inputs[0].tapLeafScript![0].controlBlock)
  differentControlBlock[0] ^= 1
  secondLeaf.data.inputs[0].tapLeafScript = [...secondLeaf.data.inputs[0].tapLeafScript!, {
    ...secondLeaf.data.inputs[0].tapLeafScript![0], controlBlock: differentControlBlock,
  }]
  assert.throws(() => assertSignedTransactionMatches(secondLeaf.toHex(), signed.toHex()), /single-signature/)
  for (const variant of ['internalKey', 'leaf', 'sighash'] as const) {
    const changed = bitcoin.Psbt.fromHex(signed.toHex())
    if (variant === 'internalKey') changed.data.inputs[0].tapInternalKey = xOnly
    else if (variant === 'leaf') changed.data.inputs[0].tapLeafScript = [{ ...expected.data.inputs[0].tapLeafScript![0], script: Buffer.from([bitcoin.opcodes.OP_1]) }]
    else changed.data.inputs[0].sighashType = bitcoin.Transaction.SIGHASH_ALL
    assert.throws(() => assertSignedTransactionMatches(expected.toHex(), changed.toHex()), /signing data|leaf or control block|hash type/)
  }
})

test('signed guard fails closed for unsupported script type and malformed PSBT without echoing input', () => {
  const expected = createPsbt('p2wpkh')
  const signed = sign(expected, 'p2wpkh')
  const unknown = bitcoin.payments.p2pkh({ pubkey: syntheticSigner.publicKey }).output!
  expected.data.inputs[0].witnessUtxo!.script = unknown
  signed.data.inputs[0].witnessUtxo!.script = unknown
  assert.throws(() => assertSignedTransactionMatches(expected.toHex(), signed.toHex()), /Only native/)
  for (const value of ['not-a-psbt-synthetic', '70736274ff', '00', '123']) {
    assert.throws(() => assertSignedTransactionMatches(value, value), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes(value))
      return true
    })
  }
})
