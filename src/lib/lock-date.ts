import { normalizeNewTimeLockCondition } from './lock-condition'
import type { TimeLockCondition } from '../types'

/** Explicit UTC text; neither the host timezone nor its date picker defines the target. */
export function parseUtcLockDate(value: string): number {
  if (!value) throw new Error('Enter a fixed date and time in UTC.')
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) throw new Error('Enter a valid UTC date and time (YYYY-MM-DD HH:mm:ss).')
  const [, year, month, day, hour, minute, second = '00'] = match
  const timestamp = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) / 1000
  const date = new Date(timestamp * 1000)
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day ||
      date.getUTCHours() !== +hour || date.getUTCMinutes() !== +minute || date.getUTCSeconds() !== +second) {
    throw new Error('Invalid UTC date or time; check the month, day and time.')
  }
  normalizeNewTimeLockCondition({ kind: 'cltv_time', timestamp })
  return timestamp
}

/** Both arguments are Unix seconds. No device-clock fallback is allowed. */
export function requireFutureDate(timestamp: number, chainMedianTime: number): void {
  normalizeNewTimeLockCondition({ kind: 'cltv_time', timestamp })
  if (!Number.isInteger(chainMedianTime) || chainMedianTime < 500_000_000 || chainMedianTime > 0xffff_ffff) throw new Error('A valid chain MTP in Unix seconds is required; device time is not a substitute.')
  if (timestamp <= chainMedianTime) throw new Error('The fixed UTC date must be in the future relative to chain MTP. Choose a later target; your entered date has not been changed.')
}

export function formatUtcDateInput(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

export function formatUtc(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

export function describeLock(lock: TimeLockCondition): string {
  return lock.kind === 'csv_blocks' ? `${lock.blocks} relative blocks (CSV)` : `${formatUtc(lock.timestamp)} (CLTV)`
}
