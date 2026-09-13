import { bitcoin, schnorrValidator, validator } from '@unisat/wallet-bitcoin'
import { Buffer } from 'buffer'

type PsbtInput = bitcoin.Psbt['data']['inputs'][number]

class SignedTransactionError extends Error {}

function requireMatch(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SignedTransactionError(message)
}

function parsePsbt(hex: string): bitcoin.Psbt {
  requireMatch(typeof hex === 'string' && /^(?:[0-9a-fA-F]{2})+$/.test(hex), 'Expected a complete hexadecimal PSBT.')
  return bitcoin.Psbt.fromHex(hex)
}

function compactSize(value: number): Buffer {
  if (value < 0xfd) return Buffer.from([value])
  const bytes = Buffer.alloc(value <= 0xffff ? 3 : 5)
  bytes[0] = value <= 0xffff ? 0xfd : 0xfe
  if (bytes.length === 3) bytes.writeUInt16LE(value, 1)
  else bytes.writeUInt32LE(value, 1)
  return bytes
}

/** Only the supported one-signature witness shapes are accepted; no annex/trailing bytes. */
function readWitness(bytes: Buffer): Buffer[] {
  let offset = 0
  const readSize = (): number => {
    requireMatch(offset < bytes.length, 'The finalized witness is incomplete.')
    const prefix = bytes[offset++]
    if (prefix < 0xfd) return prefix
    const width = prefix === 0xfd ? 2 : prefix === 0xfe ? 4 : 8
    requireMatch(width !== 8 && offset + width <= bytes.length, 'Unsupported finalized witness length.')
    const size = width === 2 ? bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset)
    offset += width
    requireMatch(size >= (width === 2 ? 0xfd : 0x10000), 'The finalized witness length is not canonical.')
    return size
  }
  const count = readSize()
  requireMatch(count >= 1 && count <= 3, 'Unsupported finalized witness stack or annex.')
  const witness: Buffer[] = []
  for (let index = 0; index < count; index += 1) {
    const size = readSize()
    requireMatch(size <= bytes.length - offset, 'The finalized witness is incomplete.')
    witness.push(bytes.subarray(offset, offset + size))
    offset += size
  }
  requireMatch(offset === bytes.length, 'The finalized witness contains trailing data.')
  return witness
}

function sameOptionalBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right)
}

function validateInputData(expected: PsbtInput, signed: PsbtInput) {
  requireMatch(expected.witnessUtxo && signed.witnessUtxo, 'Every input must retain its original witness UTXO.')
  requireMatch(Number.isSafeInteger(expected.witnessUtxo.value) && expected.witnessUtxo.value >= 0
    && signed.witnessUtxo.value === expected.witnessUtxo.value
    && signed.witnessUtxo.script.equals(expected.witnessUtxo.script), 'The wallet changed an input UTXO.')
  requireMatch(sameOptionalBytes(expected.nonWitnessUtxo, signed.nonWitnessUtxo), 'The wallet changed previous-transaction data.')
  requireMatch(!expected.redeemScript && !signed.redeemScript && !expected.witnessScript && !signed.witnessScript,
    'Only native P2WPKH and P2TR inputs are supported.')
  requireMatch(!expected.finalScriptSig && !expected.finalScriptWitness && !expected.partialSig
    && !expected.tapKeySig && !expected.tapScriptSig, 'The expected PSBT must be unsigned.')
  requireMatch(signed.finalScriptWitness && !signed.finalScriptSig?.length, 'Every input must be finalized with an empty scriptSig.')
  // BIP174 finalization may remove signing metadata. Retained metadata must agree.
  for (const key of ['tapInternalKey', 'tapMerkleRoot'] as const) {
    requireMatch(!signed[key] || (expected[key] && signed[key].equals(expected[key])), 'The wallet changed Taproot signing data.')
  }
  if (signed.tapLeafScript) {
    requireMatch(expected.tapLeafScript && signed.tapLeafScript.length === expected.tapLeafScript.length
      && signed.tapLeafScript.every((leaf, index) => {
        const original = expected.tapLeafScript![index]
        return leaf.leafVersion === original.leafVersion && leaf.script.equals(original.script) && leaf.controlBlock.equals(original.controlBlock)
      }), 'The wallet changed the Taproot leaf or control block.')
  }
  return { prevout: expected.witnessUtxo, witness: readWitness(signed.finalScriptWitness) }
}

function checkHashType(hashType: number, taproot: boolean, expected: PsbtInput, signed: PsbtInput) {
  requireMatch(hashType === bitcoin.Transaction.SIGHASH_ALL || (taproot && hashType === bitcoin.Transaction.SIGHASH_DEFAULT),
    'Signatures must commit to all inputs and outputs (SIGHASH_ALL or Taproot DEFAULT).')
  requireMatch((expected.sighashType === undefined || expected.sighashType === hashType)
    && (signed.sighashType === undefined || signed.sighashType === hashType), 'The signature hash type differs from the requested type.')
}

function verifyTaprootWitness(witness: Buffer[], expected: PsbtInput, signed: PsbtInput,
  tx: bitcoin.Transaction, inputIndex: number, scripts: Buffer[], values: number[]) {
  const signature = witness[0]
  requireMatch(signature.length === 64 || (signature.length === 65 && signature[64] === bitcoin.Transaction.SIGHASH_ALL),
    'Taproot signatures require DEFAULT or SIGHASH_ALL.')
  const hashType = signature.length === 64 ? bitcoin.Transaction.SIGHASH_DEFAULT : signature[64]
  checkHashType(hashType, true, expected, signed)
  let publicKey = scripts[inputIndex].subarray(2)
  let leafHash: Buffer | undefined
  if (expected.tapLeafScript) {
    requireMatch(expected.tapLeafScript.length === 1 && witness.length === 3, 'Only the original single-signature Taproot script path is supported.')
    const leaf = expected.tapLeafScript[0]
    requireMatch(leaf.leafVersion === 0xc0 && (leaf.controlBlock[0] & 0xfe) === leaf.leafVersion
      && witness[1].equals(leaf.script) && witness[2].equals(leaf.controlBlock), 'The wallet changed the Taproot spending script or control block.')
    // This checks the control-block commitment against the original output key.
    bitcoin.payments.p2tr({ output: scripts[inputIndex], witness })
    const chunks = bitcoin.script.decompile(leaf.script)
    requireMatch(chunks, 'Unsupported Taproot spending script.')
    const signatureOps = chunks.filter((chunk) => typeof chunk === 'number'
      && [bitcoin.opcodes.OP_CHECKSIG, bitcoin.opcodes.OP_CHECKSIGVERIFY, bitcoin.opcodes.OP_CHECKSIGADD].includes(chunk))
    const checkIndex = chunks.indexOf(bitcoin.opcodes.OP_CHECKSIG)
    const key = chunks[checkIndex - 1]
    requireMatch(signatureOps.length === 1 && checkIndex >= 1 && Buffer.isBuffer(key) && key.length === 32
      && !chunks.includes(bitcoin.opcodes.OP_CODESEPARATOR), 'Only a single public-key CHECKSIG Taproot leaf is supported.')
    publicKey = key
    leafHash = bitcoin.crypto.taggedHash('TapLeaf', Buffer.concat([Buffer.from([leaf.leafVersion]), compactSize(leaf.script.length), leaf.script]))
  } else {
    requireMatch(witness.length === 1, 'Only the requested Taproot key path is supported; annexes are not accepted.')
  }
  const hash = tx.hashForWitnessV1(inputIndex, scripts, values, hashType, leafHash)
  // The UniSat validator wraps ECPair, which takes a compressed point, then
  // strips its prefix for BIP340 verification. Lift the x-only key to even Y.
  requireMatch(schnorrValidator(Buffer.concat([Buffer.from([2]), publicKey]), hash, signature.subarray(0, 64)),
    'The finalized Taproot signature is invalid.')
}

function verifySignedTransaction(expectedHex: string, signedHex: string): { psbt: bitcoin.Psbt; transaction: bitcoin.Transaction } {
  try {
    const expected = parsePsbt(expectedHex)
    const signed = parsePsbt(signedHex)
    const unsignedBytes = expected.data.globalMap.unsignedTx.toBuffer()
    requireMatch(unsignedBytes.equals(signed.data.globalMap.unsignedTx.toBuffer()), 'The wallet changed the unsigned transaction (inputs, outputs, version, sequence, or locktime).')
    requireMatch(expected.inputCount > 0 && expected.txOutputs.length > 0, 'The transaction must have inputs and outputs.')
    const tx = bitcoin.Transaction.fromBuffer(unsignedBytes)
    const inputs = expected.data.inputs.map((input, index) => validateInputData(input, signed.data.inputs[index]))
    const scripts = inputs.map(({ prevout }) => prevout.script)
    const values = inputs.map(({ prevout }) => prevout.value)
    inputs.forEach(({ prevout, witness }, index) => {
      const original = expected.data.inputs[index]
      const returned = signed.data.inputs[index]
      const script = prevout.script
      if (script.length === 34 && script[0] === bitcoin.opcodes.OP_1 && script[1] === 32) {
        verifyTaprootWitness(witness, original, returned, tx, index, scripts, values)
      } else if (script.length === 22 && script[0] === bitcoin.opcodes.OP_0 && script[1] === 20) {
        requireMatch(!original.tapLeafScript && !original.tapInternalKey && !original.tapMerkleRoot
          && !returned.tapLeafScript && !returned.tapInternalKey && !returned.tapMerkleRoot,
        'P2WPKH inputs cannot contain Taproot signing data.')
        requireMatch(witness.length === 2, 'P2WPKH requires exactly one signature and one public key.')
        const [signature, publicKey] = witness
        const decoded = bitcoin.script.signature.decode(signature)
        checkHashType(decoded.hashType, false, original, returned)
        requireMatch(publicKey.length === 33 && (publicKey[0] === 2 || publicKey[0] === 3)
          && bitcoin.crypto.hash160(publicKey).equals(script.subarray(2)), 'The P2WPKH witness public key does not match the original UTXO.')
        const scriptCode = bitcoin.payments.p2pkh({ hash: script.subarray(2) }).output!
        requireMatch(validator(publicKey, tx.hashForWitnessV0(index, scriptCode, prevout.value, decoded.hashType), decoded.signature),
          'The finalized P2WPKH signature is invalid.')
      } else throw new SignedTransactionError('Only native P2WPKH and P2TR inputs are supported.')
    })
    // Keep the library's finalization, fee, and extraction checks enabled.
    const transaction = signed.extractTransaction()
    const extractedUnsigned = transaction.clone()
    extractedUnsigned.ins.forEach((input) => { input.script = Buffer.alloc(0); input.witness = [] })
    requireMatch(extractedUnsigned.toBuffer().equals(unsignedBytes), 'The extracted transaction differs from the expected transaction.')
    return { psbt: signed, transaction }
  } catch (error) {
    // Dependency errors can embed transaction/public-key data: never forward them.
    if (error instanceof SignedTransactionError) throw error
    throw new Error('The wallet returned an invalid or unsupported finalized PSBT.')
  }
}

/**
 * Return canonical signed PSBT hex only after transaction/prevout equality,
 * strict witness and sighash checks, and ECDSA/Schnorr verification.
 * Does not check chain state, maturity, asset semantics, or execute script consensus.
 */
export function assertSignedTransactionMatches(expectedPsbtHex: string, signedPsbtHex: string): string {
  return verifySignedTransaction(expectedPsbtHex, signedPsbtHex).psbt.toHex()
}

/** Derive the txid only after applying the same checks as the signing guard. */
export function signedTxId(expectedPsbtHex: string, signedPsbtHex: string): string {
  return verifySignedTransaction(expectedPsbtHex, signedPsbtHex).transaction.getId()
}
