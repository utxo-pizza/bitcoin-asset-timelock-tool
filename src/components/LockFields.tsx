import { Alert, Button, Input, InputNumber } from 'antd'
import type { TimeLockCondition } from '../types'
import type { BlockchainInfo } from '../lib/openapi'
import { formatUtc, formatUtcDateInput } from '../lib/lock-date'

export function RelativeBlockField({ blocks, busy, onChange }: { blocks: number; busy: boolean; onChange: (value: number) => void }) {
  return <div className="configuration-row">
    <label className="field-label" htmlFor="lock-blocks">Relative Lock (blocks, 1–65,535)</label>
    <InputNumber id="lock-blocks" disabled={busy} min={1} max={65535} precision={0} value={blocks} onChange={(value) => onChange(Math.min(65535, Math.max(1, value || 1)))} />
  </div>
}

export function FixedUtcDateField({ date, error, condition, busy, chainInfo, chainTimeError, chainTimeLoading, canRefresh, onRefresh, onChange }: {
  date: string
  error: string
  condition?: TimeLockCondition
  busy: boolean
  chainInfo: BlockchainInfo | null
  chainTimeError: string
  chainTimeLoading: boolean
  canRefresh: boolean
  onRefresh: () => void
  onChange: (value: string) => void
}) {
  return <>
    <div className="chain-time-status" aria-live="polite">
      <div>
        <strong>Chain MTP (UTC)</strong>
        <div>{chainInfo ? formatUtc(chainInfo.medianTime) : 'Unknown — load chain MTP; device time is not used.'}</div>
        {chainInfo && <span className="field-hint">{chainInfo.requestedChain} · block {chainInfo.blocks} · valid for 60 seconds.</span>}
        {chainTimeError && <div role="alert" className="field-error">{chainTimeError}</div>}
        {!canRefresh && <span className="field-hint">Connect UniSat and configure an OpenAPI key to load the selected network's MTP.</span>}
      </div>
      <Button aria-label="Refresh Chain Time" aria-busy={chainTimeLoading} disabled={busy || !canRefresh || chainTimeLoading} loading={chainTimeLoading} onClick={onRefresh}>Refresh Chain Time</Button>
    </div>
    <div className="configuration-row">
      <label className="field-label" htmlFor="lock-date">Target Chain MTP (UTC)</label>
      <div className="lock-date-field">
        <Input id="lock-date" disabled={busy} type="text" autoComplete="off" spellCheck={false} placeholder="YYYY-MM-DD HH:mm:ss" value={date} onChange={(event) => onChange(event.target.value)} status={error ? 'error' : undefined} aria-invalid={!!error} aria-describedby="lock-date-help lock-date-error" />
        <Button size="small" disabled={busy || !chainInfo || chainTimeLoading} onClick={() => { if (chainInfo) onChange(formatUtcDateInput(chainInfo.medianTime)) }}>Use Chain MTP</Button>
        <span id="lock-date-help" className="field-hint">UTC only. Chain MTP fills the starting reference, not a future lock period; enter a later target. Refreshing MTP does not change your target. No local-clock default.</span>
        {error && <div id="lock-date-error" role="alert" className="field-error">{error}</div>}
        {condition?.kind === 'cltv_time' && <span className="field-hint">Unlock only when chain MTP &gt; {formatUtc(condition.timestamp)} · Unix seconds: {condition.timestamp}</span>}
        <span className="field-hint">MTP is rechecked before signing. The selected endpoint is trusted for network identity. A fixed date can pass before the deposit confirms.</span>
      </div>
    </div>
    <Alert type="warning" showIcon message="CLTV uses BATL v2 — local validation only" description="Actual wallet CLTV signing and target-chain / asset-indexer acceptance have not been tested. Spending requires chain median time past (MTP) strictly after the target, not the browser clock. No automatic transfer at expiry." />
  </>
}
