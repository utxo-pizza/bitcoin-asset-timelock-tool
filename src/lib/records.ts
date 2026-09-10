import { ChainType } from '../types'
import type { TimeLockCondition, TimeLockRecord, Version2TimeLockRecord } from '../types'
import { normalizeTimeLockCondition } from './lock-condition'

export const LEGACY_RECORDS_KEY = 'bitcoin_asset_timelock_records'
export const RECORDS_V2_KEY = `${LEGACY_RECORDS_KEY}_v2`
export const RECORDS_KEYS = [LEGACY_RECORDS_KEY, RECORDS_V2_KEY] as const
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
type RecordSnapshot = { records: TimeLockRecord[]; errors: string[] }

export function recordLock(record: TimeLockRecord): TimeLockCondition {
  return normalizeTimeLockCondition(record.recordVersion === 2 ? record.lock : { kind: 'csv_blocks', blocks: record.lockBlocks })
}

export function recordIdentity(record: TimeLockRecord): string {
  return `${record.recordVersion === 2 ? 'v2' : 'legacy'}:${record.id}`
}

function validateRecord(value: unknown, key: string): asserts value is TimeLockRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unknown record format')
  const item = value as Record<string, unknown>
  if (key === LEGACY_RECORDS_KEY) {
    if ('recordVersion' in item || 'lock' in item) throw new Error('Ambiguous or unsupported legacy lock format')
    normalizeTimeLockCondition({ kind: 'csv_blocks', blocks: item.lockBlocks })
  } else {
    if (item.recordVersion !== 2 || 'lockBlocks' in item) throw new Error('Ambiguous or unsupported record version')
    normalizeTimeLockCondition(item.lock)
    if (!Object.values(ChainType).includes(item.chain as ChainType) || typeof item.ownerPubKey !== 'string' || !/^(02|03)[0-9a-f]{64}$/i.test(item.ownerPubKey)) {
      throw new Error('Invalid saved wallet identity')
    }
  }
  for (const field of ['id', 'ownerAddress', 'ticker', 'amount', 'timeLockAddress', 'createdAt', 'commitTxid', 'revealTxid', 'inscriptionTxid']) {
    if (typeof item[field] !== 'string' || !(item[field] as string).length) throw new Error(`Invalid record ${field}`)
  }
  for (const field of ['runeId', 'runeName', 'initialCommitTxid', 'initialRevealTxid', 'transferToLockTxid', 'lockCommitTxid', 'lockRevealTxid', 'unlockTxid']) {
    if (item[field] !== undefined && typeof item[field] !== 'string') throw new Error(`Invalid record ${field}`)
  }
  if (!Number.isFinite(Date.parse(item.createdAt as string)) ||
      !Number.isSafeInteger(item.inscriptionVout) || (item.inscriptionVout as number) < 0 ||
      !Number.isSafeInteger(item.inscriptionSatoshi) || (item.inscriptionSatoshi as number) <= 0 ||
      !['pending', 'locked', 'unlocked'].includes(item.status as string)) throw new Error('Invalid record state or outpoint')
  if (item.assetKind !== undefined && !['brc20', 'runes'].includes(item.assetKind as string)) throw new Error('Unknown asset kind')
  if (item.chain !== undefined && !Object.values(ChainType).includes(item.chain as ChainType)) throw new Error('Unknown saved network')
  if (item.broadcastStep !== undefined && (!Number.isInteger(item.broadcastStep) || (item.broadcastStep as number) < 0 || (item.broadcastStep as number) > 5)) throw new Error('Invalid broadcast progress')
  if (item.pendingPsbts !== undefined && (!Array.isArray(item.pendingPsbts) || item.pendingPsbts.length !== 5 || item.pendingPsbts.some((psbt) => typeof psbt !== 'string' || !psbt))) throw new Error('Invalid saved transaction chain')
}

function readNamespace(storage: StoragePort, key: string) {
  const raw = storage.getItem(key)
  const items: unknown = raw === null ? [] : JSON.parse(raw)
  if (!Array.isArray(items)) throw new Error('Expected a record array')
  const records: TimeLockRecord[] = []
  for (const item of items) {
    validateRecord(item, key)
    records.push(item)
  }
  return { raw, records }
}

/** A damaged namespace stays untouched; the other namespace can still be displayed. */
export function readRecords(storage: StoragePort): RecordSnapshot {
  const records: TimeLockRecord[] = []
  const errors: string[] = []
  for (const key of RECORDS_KEYS) {
    try { records.push(...readNamespace(storage, key).records) }
    catch (error) { errors.push(`Cannot read ${key}: ${error instanceof Error ? error.message : 'storage unavailable'}. Original data was not changed.`) }
  }
  const ids = new Set<string>()
  for (const record of records) {
    if (ids.has(record.id)) errors.push(`Conflicting record ID ${record.id}. Changes are blocked; original data was not changed.`)
    ids.add(record.id)
  }
  return { records, errors }
}

export function assertRecordsWritable(storage: StoragePort): void {
  const { errors } = readRecords(storage)
  if (errors.length) throw new Error(errors.join(' '))
}

function writeNamespace(storage: StoragePort, key: string, previous: string | null, records: TimeLockRecord[]) {
  if (storage.getItem(key) !== previous) throw new Error('Records changed in another tab. Refresh and retry; nothing was overwritten.')
  try { storage.setItem(key, JSON.stringify(records)) }
  catch { throw new Error('Cannot save local records. The previous saved data was not replaced. Stop and preserve the transaction information before retrying.') }
}

export function createStoredRecord(storage: StoragePort, record: Version2TimeLockRecord): Version2TimeLockRecord {
  assertRecordsWritable(storage)
  validateRecord(record, RECORDS_V2_KEY)
  if (readRecords(storage).records.some((item) => item.id === record.id)) throw new Error('Conflicting record ID; no record was saved.')
  const namespace = readNamespace(storage, RECORDS_V2_KEY)
  writeNamespace(storage, RECORDS_V2_KEY, namespace.raw, [record, ...namespace.records])
  return record
}

/** Compare the exact saved item to avoid resuming stale progress or crossing namespaces. */
export function getCurrentRecord(storage: StoragePort, expected: TimeLockRecord): TimeLockRecord {
  assertRecordsWritable(storage)
  const current = readRecords(storage).records.find((item) => recordIdentity(item) === recordIdentity(expected))
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The record is missing or changed in another tab. Refresh and retry; no other record was updated.')
  return current
}

export function updateStoredRecord(storage: StoragePort, expected: TimeLockRecord, patch: Pick<Partial<TimeLockRecord>, 'status' | 'broadcastStep' | 'pendingPsbts' | 'unlockTxid'>): TimeLockRecord {
  const current = getCurrentRecord(storage, expected)
  const key = current.recordVersion === 2 ? RECORDS_V2_KEY : LEGACY_RECORDS_KEY
  const namespace = readNamespace(storage, key)
  const next = { ...current, ...patch } as TimeLockRecord
  // Match the JSON representation returned on the next read (undefined means removed).
  const saved: TimeLockRecord = JSON.parse(JSON.stringify(next))
  validateRecord(saved, key)
  writeNamespace(storage, key, namespace.raw, namespace.records.map((item) => item.id === current.id ? saved : item))
  return saved
}
