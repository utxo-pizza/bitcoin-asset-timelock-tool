import { bitcoin, toPsbtNetwork } from '@unisat/wallet-bitcoin'
import { NetworkType } from '@unisat/wallet-types'
import { Buffer } from 'buffer'
import { OwnerAddressType } from '../types'
import type { ChainType, TimeLockBlocks, TimeLockCondition } from '../types'
import { normalizeTimeLockCondition } from './lock-condition'

const MAGIC = 'BATL'
const RUNESTONE_NOP_TAG = 127n
const RUNESTONE_MAGIC = BigInt('0x4241544c')
const U128_MAX = (1n << 128n) - 1n

function networkForChain(chain?: ChainType | string) {
  const value = String(chain || '')
  return value === 'BITCOIN_MAINNET' || value === 'FRACTAL_BITCOIN_MAINNET' || !value
    ? toPsbtNetwork(NetworkType.MAINNET)
    : toPsbtNetwork(NetworkType.TESTNET)
}

function decodeSmallInteger(chunk: Buffer | number): number | undefined {
  if (typeof chunk === 'number') {
    if (chunk === bitcoin.opcodes.OP_0) return 0
    if (chunk >= bitcoin.opcodes.OP_1 && chunk <= bitcoin.opcodes.OP_16) return chunk - bitcoin.opcodes.OP_1 + 1
    return undefined
  }
  return chunk.length === 1 ? chunk[0] : undefined
}

function isOwnerAddressType(value: number): value is OwnerAddressType {
  return value === OwnerAddressType.P2WPKH_EVEN || value === OwnerAddressType.P2WPKH_ODD || value === OwnerAddressType.P2TR
}

export type TimeLockMetadata = {
  xOnlyPubKey: string
  ownerAddressType: OwnerAddressType
} & (
  | { version: 1; lockBlocks: TimeLockBlocks }
  | { version: 2; lockTime: number }
)

/** BATL v1 is frozen CSV; v2 is exclusively CLTV time, never height or relative time. */
export function getMetadataLockCondition(metadata: TimeLockMetadata): TimeLockCondition {
  if (metadata.version === 1 && !('lockTime' in metadata)) {
    return normalizeTimeLockCondition({ kind: 'csv_blocks', blocks: metadata.lockBlocks })
  }
  if (metadata.version === 2 && !('lockBlocks' in metadata)) {
    return normalizeTimeLockCondition({ kind: 'cltv_time', timestamp: metadata.lockTime })
  }
  throw new Error('Unsupported or ambiguous BATL metadata version.')
}

function metadataFields(metadata: TimeLockMetadata): { pubKey: Buffer; lockValue: number } {
  if (!/^[0-9a-fA-F]{64}$/.test(metadata.xOnlyPubKey) || !isOwnerAddressType(metadata.ownerAddressType)) {
    throw new Error('BATL requires a 32-byte x-only key and supported owner address type.')
  }
  const lock = getMetadataLockCondition(metadata)
  return { pubKey: Buffer.from(metadata.xOnlyPubKey, 'hex'), lockValue: lock.kind === 'csv_blocks' ? lock.blocks : lock.timestamp }
}

function decodedMetadata(version: number, lockValue: number, pubKey: Buffer, ownerAddressType: number): TimeLockMetadata | undefined {
  if (pubKey.length !== 32 || !isOwnerAddressType(ownerAddressType)) return undefined
  const owner = { xOnlyPubKey: pubKey.toString('hex'), ownerAddressType }
  const metadata: TimeLockMetadata | undefined = version === 1
    ? { ...owner, version: 1, lockBlocks: lockValue }
    : version === 2 ? { ...owner, version: 2, lockTime: lockValue } : undefined
  if (!metadata) return undefined
  try { getMetadataLockCondition(metadata); return metadata } catch { return undefined }
}

function scriptSource(script: Buffer | string): Buffer | undefined {
  if (typeof script !== 'string') return script
  return /^(?:[0-9a-fA-F]{2})+$/.test(script) ? Buffer.from(script, 'hex') : undefined
}

/**
 * Returns the compact BATL owner address descriptor. P2WPKH needs the
 * compressed public-key parity because an x-only key intentionally omits it.
 */
export function getOwnerAddressType(address: string, publicKey: string): OwnerAddressType {
  const normalizedAddress = address.trim().toLowerCase()
  const normalizedPubKey = publicKey.trim().replace(/^0x/i, '').toLowerCase()
  if (!/^(02|03)[0-9a-f]{64}$/.test(normalizedPubKey)) throw new Error('A compressed public key is required for BATL owner address metadata.')
  if (normalizedAddress.startsWith('bc1q') || normalizedAddress.startsWith('tb1q')) {
    return normalizedPubKey.startsWith('02') ? OwnerAddressType.P2WPKH_EVEN : OwnerAddressType.P2WPKH_ODD
  }
  if (normalizedAddress.startsWith('bc1p') || normalizedAddress.startsWith('tb1p')) return OwnerAddressType.P2TR
  throw new Error('BATL supports only P2WPKH and BIP86 P2TR owner addresses.')
}

/** Reconstructs the owner address for either BATL version. */
export function deriveOwnerAddress(metadata: TimeLockMetadata, chain?: ChainType | string): string | undefined {
  const xOnly = Buffer.from(metadata.xOnlyPubKey, 'hex')
  if (xOnly.length !== 32) return undefined
  const network = networkForChain(chain)
  if (metadata.ownerAddressType === OwnerAddressType.P2TR) {
    return bitcoin.payments.p2tr({ internalPubkey: xOnly, network }).address
  }
  const prefix = metadata.ownerAddressType === OwnerAddressType.P2WPKH_EVEN ? 0x02 : 0x03
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.concat([Buffer.from([prefix]), xOnly]), network }).address
}

/** Zero-satoshi marker: v1 has 2-byte BE CSV blocks; v2 has 4-byte BE Unix seconds. */
export function buildTimeLockMetadataScript(metadata: TimeLockMetadata): Buffer {
  const { pubKey, lockValue } = metadataFields(metadata)
  const encodedLock = Buffer.alloc(metadata.version === 1 ? 2 : 4)
  encodedLock.writeUIntBE(lockValue, 0, encodedLock.length)
  return Buffer.from(bitcoin.script.compile([
    bitcoin.opcodes.OP_RETURN,
    Buffer.from(MAGIC, 'ascii'),
    Buffer.from([metadata.version]),
    encodedLock,
    pubKey,
    Buffer.from([metadata.ownerAddressType]),
  ]))
}

export function decodeTimeLockMetadataScript(script: Buffer | string): TimeLockMetadata | undefined {
  const source = scriptSource(script)
  if (!source) return undefined
  const chunks = bitcoin.script.decompile(source)
  if (!chunks || chunks[0] !== bitcoin.opcodes.OP_RETURN) return undefined
  if (chunks.length !== 6) return undefined
  const [magic, version, lockValue, pubKey, addressType] = chunks.slice(1)
  const versionValue = decodeSmallInteger(version)
  const addressTypeValue = decodeSmallInteger(addressType)
  const lockSize = versionValue === 1 ? 2 : versionValue === 2 ? 4 : 0
  if (!Buffer.isBuffer(magic) || magic.toString('ascii') !== MAGIC || !Buffer.isBuffer(lockValue) || !lockSize || lockValue.length !== lockSize || !Buffer.isBuffer(pubKey) || addressTypeValue === undefined) return undefined
  return decodedMetadata(versionValue!, lockValue.readUIntBE(0, lockSize), pubKey, addressTypeValue)
}

/** Runes retain one OP_RETURN, so BATL is carried in ignored Nop (127) fields before Tag.Body. */
export function encodeRunestoneRecoveryMetadata(metadata: TimeLockMetadata): bigint[] {
  const { pubKey, lockValue } = metadataFields(metadata)
  return [
    RUNESTONE_NOP_TAG, RUNESTONE_MAGIC,
    RUNESTONE_NOP_TAG, BigInt(metadata.version),
    RUNESTONE_NOP_TAG, BigInt(lockValue),
    // Runestone integers are u128. Store the 32-byte x-only key as two
    // unsigned 128-bit big-endian halves rather than one 256-bit integer.
    RUNESTONE_NOP_TAG, BigInt(`0x${pubKey.subarray(0, 16).toString('hex')}`),
    RUNESTONE_NOP_TAG, BigInt(`0x${pubKey.subarray(16).toString('hex')}`),
    RUNESTONE_NOP_TAG, BigInt(metadata.ownerAddressType),
  ]
}

export function decodeRunestoneRecoveryMetadata(values: bigint[]): TimeLockMetadata | undefined {
  for (let index = 0; index + 1 < values.length; index += 2) {
    // Edict integers after Tag.Body are not metadata fields.
    if (values[index] === 0n) return undefined
    if (values[index] !== RUNESTONE_NOP_TAG || values[index + 1] !== RUNESTONE_MAGIC) continue
    if (index + 11 >= values.length) return undefined
    if ([2, 4, 6, 8, 10].some((offset) => values[index + offset] !== RUNESTONE_NOP_TAG)) return undefined
    const version = values[index + 3]
    if (version !== 1n && version !== 2n) return undefined
    const high = values[index + 7]
    const low = values[index + 9]
    if (high < 0n || high > U128_MAX || low < 0n || low > U128_MAX) return undefined
    const hex = high.toString(16).padStart(32, '0') + low.toString(16).padStart(32, '0')
    return decodedMetadata(Number(version), Number(values[index + 5]), Buffer.from(hex, 'hex'), Number(values[index + 11]))
  }
  return undefined
}

export function decodeRunestoneRecoveryMetadataScript(script: Buffer | string): TimeLockMetadata | undefined {
  const source = scriptSource(script)
  if (!source) return undefined
  const chunks = bitcoin.script.decompile(source)
  if (!chunks || chunks.length < 3 || chunks[0] !== bitcoin.opcodes.OP_RETURN || chunks[1] !== bitcoin.opcodes.OP_13) return undefined
  const payloadChunks = chunks.slice(2)
  if (!payloadChunks.every(Buffer.isBuffer)) return undefined
  const payload = Buffer.concat(payloadChunks as Buffer[])
  const values: bigint[] = []
  for (let index = 0; index < payload.length;) {
    let value = 0n
    let shift = 0n
    let completed = false
    while (index < payload.length) {
      const byte = payload[index++]
      value |= BigInt(byte & 0x7f) << shift
      if (value > U128_MAX) return undefined
      if ((byte & 0x80) === 0) { completed = true; break }
      shift += 7n
      if (shift >= 133n) return undefined
    }
    if (!completed) return undefined
    values.push(value)
  }
  return decodeRunestoneRecoveryMetadata(values)
}
