import { Buffer } from 'buffer'
import { ChainType } from '../types'

export const PUBLIC_RECOVERY_FORMAT = 'batl-recovery'
export const PUBLIC_RECOVERY_VERSION = 1
export const MAX_PUBLIC_RECOVERY_BYTES = 4096
export const MAX_PUBLIC_RECOVERY_OUTPOINTS = 20

export type PublicRecoveryOutpoint = { txid: string; vout: number }
export type PublicRecoveryManifest = {
  format: typeof PUBLIC_RECOVERY_FORMAT
  version: typeof PUBLIC_RECOVERY_VERSION
  chain: ChainType
  outpoints: PublicRecoveryOutpoint[]
}

function dataObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Recovery manifest fields must be plain JSON objects.')
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  const ownKeys = Reflect.ownKeys(value)
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty('value'))) {
    throw new Error('Recovery manifest contains missing, unsupported, or non-data fields.')
  }
  return value as Record<string, unknown>
}

function validateManifest(value: unknown): PublicRecoveryManifest {
  const object = dataObject(value, ['format', 'version', 'chain', 'outpoints'])
  if (object.format !== PUBLIC_RECOVERY_FORMAT || object.version !== PUBLIC_RECOVERY_VERSION) {
    throw new Error('Unsupported public recovery manifest format or version.')
  }
  if (typeof object.chain !== 'string' || !Object.values(ChainType).includes(object.chain as ChainType)) {
    throw new Error('Recovery manifest must name a supported chain.')
  }
  const entries = object.outpoints
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_PUBLIC_RECOVERY_OUTPOINTS) {
    throw new Error(`Recovery manifest must contain 1–${MAX_PUBLIC_RECOVERY_OUTPOINTS} outpoints.`)
  }
  if (Reflect.ownKeys(entries).length !== entries.length + 1) {
    throw new Error('Recovery manifest outpoints must be a plain JSON array.')
  }
  const seen = new Set<string>()
  const outpoints: PublicRecoveryOutpoint[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, String(index))
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('Recovery manifest outpoints must contain only JSON data.')
    }
    const entry = dataObject(descriptor.value, ['txid', 'vout'])
    if (typeof entry.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(entry.txid)
      || typeof entry.vout !== 'number' || !Number.isInteger(entry.vout)
      || entry.vout < 0 || entry.vout > 0xffffffff) {
      throw new Error('Recovery manifest contains an invalid outpoint.')
    }
    const txid = entry.txid.toLowerCase()
    const key = `${txid}:${entry.vout}`
    if (seen.has(key)) throw new Error('Recovery manifest contains a duplicate outpoint.')
    seen.add(key)
    outpoints.push({ txid, vout: entry.vout })
  }
  // Never serialize application records: reconstruct this public-only whitelist.
  return { format: PUBLIC_RECOVERY_FORMAT, version: PUBLIC_RECOVERY_VERSION, chain: object.chain as ChainType, outpoints }
}

/** Public pointers only, not a record export, chain-state proof, or payment authorization. */
export function serializePublicRecoveryManifest(manifest: unknown): string {
  const text = JSON.stringify(validateManifest(manifest))
  if (Buffer.byteLength(text, 'utf8') > MAX_PUBLIC_RECOVERY_BYTES) {
    throw new Error(`Recovery manifest exceeds ${MAX_PUBLIC_RECOVERY_BYTES} UTF-8 bytes.`)
  }
  return text
}

export function parsePublicRecoveryManifest(text: string): PublicRecoveryManifest {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_PUBLIC_RECOVERY_BYTES) {
    throw new Error(`Recovery manifest must be at most ${MAX_PUBLIC_RECOVERY_BYTES} UTF-8 bytes.`)
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Recovery manifest is not valid JSON.') }
  return validateManifest(value)
}
