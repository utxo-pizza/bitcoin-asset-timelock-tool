import type { TimeLockBlocks, TimeLockCondition } from '../types'

export const CLTV_MIN_TIMESTAMP = 500_000_000
export const CLTV_MAX_TIMESTAMP = 0xffff_ffff
// Inclusion needs target < previous-tip MTP < confirming block time <= uint32 max.
// Keep the wire bound separate so recovery can still preserve every encoded value.
export const CLTV_MAX_CREATABLE_TIMESTAMP = CLTV_MAX_TIMESTAMP - 2

/** Consensus-representable values only. Future-date UX validation belongs at the UI boundary. */
export function normalizeTimeLockCondition(value: unknown): TimeLockCondition {
  if (!value || typeof value !== 'object') throw new Error('An explicit time-lock condition is required.')
  const condition = value as Record<string, unknown>
  if (condition.kind === 'csv_blocks') {
    const blocks = condition.blocks
    if (typeof blocks !== 'number' || !Number.isInteger(blocks) || blocks < 1 || blocks > 0xffff || 'timestamp' in condition) {
      throw new Error('Relative block time lock must be an integer from 1 to 65535.')
    }
    return { kind: 'csv_blocks', blocks }
  }
  if (condition.kind === 'cltv_time') {
    const timestamp = condition.timestamp
    if (typeof timestamp !== 'number' || !Number.isInteger(timestamp) || timestamp < CLTV_MIN_TIMESTAMP || timestamp > CLTV_MAX_TIMESTAMP || 'blocks' in condition) {
      throw new Error('Absolute time lock must be an integer Unix second from 500000000 to 4294967295.')
    }
    return { kind: 'cltv_time', timestamp }
  }
  throw new Error('Unsupported time-lock condition kind.')
}

/** Deposit-only bounds; pure derivation and recovery retain the full wire range. */
export function normalizeNewTimeLockCondition(value: unknown): TimeLockCondition {
  const condition = normalizeTimeLockCondition(value)
  if (condition.kind === 'cltv_time' && condition.timestamp > CLTV_MAX_CREATABLE_TIMESTAMP) {
    throw new Error('New absolute time locks must not exceed 2106-02-07 06:28:13 UTC; later targets cannot confirm an unlock under current timestamp rules.')
  }
  return condition
}

/** One compatibility boundary for all builders; neither omission nor ambiguous dual input is allowed. */
export function resolveTimeLockCondition(params: { lock?: TimeLockCondition; lockBlocks?: TimeLockBlocks }): TimeLockCondition {
  if ((params.lock !== undefined) === (params.lockBlocks !== undefined)) {
    throw new Error('Provide exactly one of lock or legacy lockBlocks.')
  }
  return normalizeTimeLockCondition(params.lock !== undefined ? params.lock : { kind: 'csv_blocks', blocks: params.lockBlocks })
}
