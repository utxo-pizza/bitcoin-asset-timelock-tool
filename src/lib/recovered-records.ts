import type { ChainType } from '../types'
import { requireKnownChain } from './openapi'

export const RECOVERED_RECORDS_KEY = 'bitcoin_asset_timelock_recovered_v1'
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
const browserStorage: StoragePort = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
}
export type RecoveryReference = {
  schemaVersion: 1
  chain: ChainType
  txid: string
  vout: number
  lockKind: 'csv_blocks' | 'cltv_time'
  source: 'txid' | 'manifest' | 'inscription'
  restoredAt: number
  /** Last prepared/sent attempt, never evidence of broadcast or confirmation. */
  unlockTxid?: string
}

export function recoveryKey(chain: ChainType | string, txid: string, vout: number): string {
  requireKnownChain(chain)
  if (!/^[0-9a-f]{64}$/i.test(txid) || !Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('Invalid recovery outpoint.')
  return `${chain}:${txid.toLowerCase()}:${vout}`
}

function validate(value: unknown): RecoveryReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovered reference.')
  const prototype: unknown = Object.getPrototypeOf(value)
  const keys = ['schemaVersion', 'chain', 'txid', 'vout', 'lockKind', 'source', 'restoredAt', 'unlockTxid']
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key) || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('Unsupported recovered reference fields.')
  const row = value as Record<string, unknown>
  if (row.schemaVersion !== 1 || typeof row.txid !== 'string' || typeof row.vout !== 'number' || typeof row.chain !== 'string') throw new Error('Unsupported recovered reference version or outpoint.')
  recoveryKey(row.chain, row.txid, row.vout)
  if (!['csv_blocks', 'cltv_time'].includes(row.lockKind as string) || !['txid', 'manifest', 'inscription'].includes(row.source as string) || !Number.isSafeInteger(row.restoredAt) || (row.restoredAt as number) < 0) throw new Error('Invalid recovered reference fields.')
  if (Object.prototype.hasOwnProperty.call(row, 'unlockTxid') && (typeof row.unlockTxid !== 'string' || !/^[0-9a-f]{64}$/i.test(row.unlockTxid))) throw new Error('Invalid recovered unlock attempt.')
  return {
    schemaVersion: 1, chain: row.chain as ChainType, txid: row.txid.toLowerCase(), vout: row.vout,
    lockKind: row.lockKind as RecoveryReference['lockKind'], source: row.source as RecoveryReference['source'], restoredAt: row.restoredAt as number,
    ...(typeof row.unlockTxid === 'string' ? { unlockTxid: row.unlockTxid.toLowerCase() } : {}),
  }
}

function namespace(storage: StoragePort) {
  const raw = storage.getItem(RECOVERED_RECORDS_KEY)
  const data: unknown = raw === null ? [] : JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error('Expected recovered reference array.')
  const records = data.map(validate)
  const ids = records.map((row) => recoveryKey(row.chain, row.txid, row.vout))
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate recovered outpoint.')
  return { raw, records }
}

export function readRecoveredSnapshot(storage: StoragePort = browserStorage): { records: RecoveryReference[]; errors: string[] } {
  try { return { records: namespace(storage).records, errors: [] } }
  catch { return { records: [], errors: [`Cannot read ${RECOVERED_RECORDS_KEY}. Original data was not changed; restore the damaged namespace before saving.`] } }
}

function write(storage: StoragePort, previous: string | null, records: RecoveryReference[]) {
  if (storage.getItem(RECOVERED_RECORDS_KEY) !== previous) throw new Error('Recovered references changed in another tab. Refresh; nothing was overwritten.')
  try { storage.setItem(RECOVERED_RECORDS_KEY, JSON.stringify(records)) }
  catch { throw new Error('Cannot save recovered references. Preserve the public outpoint and any unlock attempt before retrying.') }
  return records
}

export function saveRecoveredReference(reference: RecoveryReference, storage: StoragePort = browserStorage): RecoveryReference[] {
  const row = validate(reference)
  const current = namespace(storage)
  const existing = current.records.find((item) => recoveryKey(item.chain, item.txid, item.vout) === recoveryKey(row.chain, row.txid, row.vout))
  if (existing) {
    if (existing.lockKind !== row.lockKind) throw new Error('Recovered lock condition conflicts with the saved reference.')
    return current.records
  }
  return write(storage, current.raw, [row, ...current.records])
}

export function getCurrentRecoveredReference(expected: RecoveryReference, storage: StoragePort = browserStorage): RecoveryReference {
  const row = validate(expected)
  const saved = namespace(storage).records.find((item) => recoveryKey(item.chain, item.txid, item.vout) === recoveryKey(row.chain, row.txid, row.vout))
  if (!saved || JSON.stringify(saved) !== JSON.stringify(row)) throw new Error('Recovered reference is missing or changed. Refresh before continuing.')
  return saved
}

export function updateRecoveredReference(expected: RecoveryReference, update: Pick<Partial<RecoveryReference>, 'unlockTxid'>, storage: StoragePort = browserStorage): RecoveryReference[] {
  if (!update || typeof update !== 'object' || Reflect.ownKeys(update).some((key) => key !== 'unlockTxid' || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(update, key)!, 'value'))) throw new Error('Only the unlock attempt may be updated.')
  const row = validate(expected)
  const current = namespace(storage)
  const index = current.records.findIndex((item) => recoveryKey(item.chain, item.txid, item.vout) === recoveryKey(row.chain, row.txid, row.vout))
  if (index < 0 || JSON.stringify(current.records[index]) !== JSON.stringify(row)) throw new Error('Recovered reference is missing or changed. Refresh before continuing.')
  current.records[index] = validate({ ...row, ...update })
  return write(storage, current.raw, current.records)
}
