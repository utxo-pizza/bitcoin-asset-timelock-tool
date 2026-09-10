import { CopyOutlined, UnlockOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Input, InputNumber, List, Segmented, Select, Space, Tag, Typography } from 'antd'
import type { AssetKind, ResultState, TimeLockBlocks, TimeLockCondition, TimeLockRecord } from '../types'
import type { Brc20Balance, BlockchainInfo } from '../lib/openapi'
import { isCltvMature } from '../lib/openapi'
import { CLTV_MAX_CREATABLE_TIMESTAMP } from '../lib/lock-condition'
import { describeLock } from '../lib/lock-date'
import { recordIdentity, recordLock } from '../lib/records'
import { shortAddress } from '../lib/format'
import { getAddressExplorerUrl, getTransactionExplorerUrl } from '../lib/explorer'
import { ResultAlert } from './ResultAlert'
import { FixedUtcDateField, RelativeBlockField } from './LockFields'
import type { LockWorkspace } from '../hooks/useLockWorkspaces'

type Props = {
  ticker: string
  brc20Balances: Brc20Balance[]
  brc20BalancesLoading: boolean
  runeBalances: import('../types').RuneIndexerBalance[]
  runeBalancesLoading: boolean
  amount: string
  assetKind: AssetKind
  runeReference: string
  lockBlocks: TimeLockBlocks
  workspace: LockWorkspace
  lockDate: string
  lockDateError: string
  lockCondition?: TimeLockCondition
  busy: boolean
  recordErrors: string[]
  chainInfo: BlockchainInfo | null
  chainTimeError: string
  chainTimeLoading: boolean
  canRefreshChainTime: boolean
  feeRate: number
  timeLockAddress: string
  hasOpenApiKey: boolean
  canCreate: boolean
  result: ResultState
  records: TimeLockRecord[]
  onTickerChange: (value: string) => void
  onAmountChange: (value: string) => void
  onAssetKindChange: (value: AssetKind) => void
  onRuneReferenceChange: (value: string) => void
  onLockBlocksChange: (value: TimeLockBlocks) => void
  onLockDateChange: (value: string) => void
  onRefreshChainTime: () => void
  onFeeRateChange: (value: number) => void
  onCreate: () => void
  onResume: (record: TimeLockRecord) => void
  onUnlock: (record: TimeLockRecord, skipMaturityCheck?: boolean) => void
  onCopy: (value: string, label: string) => void
}

function cltvMaturityLabel(record: TimeLockRecord, info: BlockchainInfo | null): string {
  const lock = recordLock(record)
  if (lock.kind !== 'cltv_time') return ''
  if (lock.timestamp > CLTV_MAX_CREATABLE_TIMESTAMP) return 'This fixed date cannot confirm an unlock under current timestamp rules. The saved condition is preserved.'
  if (!info || !record.chain || info.requestedChain !== record.chain) return 'Maturity unknown; check the original network before signing.'
  try {
    return isCltvMature(info, lock.timestamp, record.chain)
      ? 'Target passed at the last MTP check; Check & Unlock rechecks before signing.'
      : 'Target has not passed at the last MTP check.'
  } catch { return 'Maturity unknown; refresh chain time before signing.' }
}

export function OperationPanel(props: Props) {
  return (
    <>
      <Card title={`2. Create ${props.workspace.toUpperCase()} Time Lock`} className="tool-card">
        <Space direction="vertical" size="large" className="full">
          <Segmented
            block
            disabled={props.busy}
            value={props.assetKind}
            options={[{ label: 'BRC-20 transfer inscription', value: 'brc20' }, { label: 'Rune / Runestone', value: 'runes' }]}
            onChange={(value) => props.onAssetKindChange(value as AssetKind)}
          />
          <Alert
            type="info"
            showIcon
            message={props.assetKind === 'brc20'
              ? 'Deposit broadcasts five transactions: inscribe transfer to yourself (2) → send it to the time-lock address (1) → inscribe transfer at the time-lock address (2).'
              : 'Rune deposit broadcasts one Runestone transaction. Select a Rune held by the connected wallet; the tool then selects enough transferable Rune UTXOs. Automatic fee funding always includes a Rune-change output and pointer as a safety measure.'}
            description={props.assetKind === 'brc20'
              ? 'All five transactions are signed before any are broadcast. The tool refreshes and automatically uses the largest available wallet UTXO; it must be large enough to fund the flow. The final transfer inscription is subject to the selected lock condition.'
              : 'Enter the exact base-unit amount. The tool uses the smallest indexed Rune UTXO that can cover it, or combines multiple Rune UTXOs when necessary. When extra fee funding is needed, it automatically uses the current available wallet UTXOs.'}
          />

          <div className="step-panel">
            <Typography.Title level={5}>{props.assetKind === 'brc20' ? 'Configure BRC-20 Time Lock' : 'Configure Rune Time Lock'}</Typography.Title>
            <div className="configuration-form">
              <div className="configuration-row">
                <label className="field-label" htmlFor="asset-reference">{props.assetKind === 'brc20' ? 'Token Tick' : 'Rune'}</label>
                {props.assetKind === 'brc20'
                  ? <Select id="asset-reference" disabled={props.busy} value={props.ticker || undefined} placeholder="Select a wallet BRC-20 token" loading={props.brc20BalancesLoading} options={props.brc20Balances.map((balance) => ({ value: balance.ticker, label: `${balance.ticker} (Available: ${balance.availableBalance})` }))} onChange={props.onTickerChange} />
                  : <Select id="asset-reference" disabled={props.busy} value={props.runeReference || undefined} placeholder="Select a wallet Rune" loading={props.runeBalancesLoading} options={props.runeBalances.map((balance) => ({ value: balance.runeid, label: `${balance.spacedRune || balance.rune || balance.runeid} (${balance.runeid}; Available: ${balance.amount})` }))} onChange={props.onRuneReferenceChange} />}
              </div>
              <div className="configuration-row">
                <label className="field-label" htmlFor="transfer-amount">Transfer Amount{props.assetKind === 'runes' ? ' (base units)' : ''}</label>
                <Input id="transfer-amount" disabled={props.busy} value={props.amount} onChange={(event) => props.onAmountChange(event.target.value)} placeholder="Example: 100" inputMode={props.assetKind === 'runes' ? 'numeric' : 'decimal'} />
              </div>
              {props.workspace === 'csv'
                ? <RelativeBlockField blocks={props.lockBlocks} busy={props.busy} onChange={props.onLockBlocksChange} />
                : <FixedUtcDateField date={props.lockDate} error={props.lockDateError} condition={props.lockCondition} busy={props.busy} chainInfo={props.chainInfo} chainTimeError={props.chainTimeError} chainTimeLoading={props.chainTimeLoading} canRefresh={props.canRefreshChainTime} onRefresh={props.onRefreshChainTime} onChange={props.onLockDateChange} />}
              <div className="configuration-row">
                <label className="field-label">Time-lock Address</label>
                <div className="address-box" onClick={() => props.timeLockAddress && props.onCopy(props.timeLockAddress, 'Time-lock address copied')}>
                  <span>{props.timeLockAddress || 'Connect a wallet to generate the time-lock address'}</span>
                  {props.timeLockAddress && <CopyOutlined />}
                </div>
              </div>
              <div className="configuration-row">
                <label className="field-label" htmlFor="fee-rate">Fee Rate (sat/vB)</label>
                <div>
                  <InputNumber id="fee-rate" disabled={props.busy} min={1} max={1000} precision={0} value={props.feeRate} onChange={(value) => props.onFeeRateChange(value || 1)} />
                  <span className="field-hint">Defaults to the current network mempool recommendation.</span>
                </div>
              </div>
            </div>
            <div className="configuration-action">
              <Button type="primary" disabled={props.busy || !props.canCreate || !props.hasOpenApiKey || !!props.lockDateError || props.recordErrors.length > 0} onClick={props.onCreate}>
                Lock Asset
              </Button>
            </div>
          </div>
        </Space>
        <ResultAlert result={props.result} />
      </Card>

      <Card title={`3. ${props.workspace.toUpperCase()} Records / Unlock`} className="tool-card">
        <Alert
          type="warning"
          showIcon
          message="Records are stored only in this browser's LocalStorage"
          description={`Do not clear site data. ${props.workspace === 'csv' ? 'This page shows legacy and new CSV records; their locks use BATL v1.' : 'This page shows fixed UTC date records; their locks use BATL v2.'} BATL carries public lock parameters, not a backup of signed transactions; this page has no transaction-ID recovery tool. Do not operate the same record in multiple tabs: LocalStorage is not transactional. Broadcast status is not confirmation or maturity.`}
        />
        {props.workspace === 'cltv' && props.records.some((record) => record.status === 'locked') && (
          <Typography.Paragraph className="mt-16">
            Test Unlock skips only the web MTP check for one explicitly confirmed attempt. It still asks your wallet to sign and broadcast the original unlock transaction; it may really spend a mature output. Check &amp; Unlock keeps the normal check.
          </Typography.Paragraph>
        )}
        {props.recordErrors.map((error, index) => <Alert key={index} className="mt-16" type="error" showIcon message="Local records unavailable for changes" description={error} />)}
        <List
          className="mt-16"
          locale={{ emptyText: `No local ${props.workspace.toUpperCase()} time-lock records yet` }}
          dataSource={props.records}
          rowKey={recordIdentity}
          renderItem={(record) => (
            <List.Item
              actions={record.status === 'pending'
                ? [<Button key="resume" type="primary" disabled={props.busy || props.recordErrors.length > 0} onClick={() => props.onResume(record)}>Continue Broadcast</Button>]
                : record.status === 'locked'
                  ? [<Space key="unlock" direction="vertical" align="end">
                    <Button type="primary" disabled={props.busy || props.recordErrors.length > 0} icon={<UnlockOutlined />} onClick={() => props.onUnlock(record)}>{recordLock(record).kind === 'cltv_time' ? 'Check & Unlock' : 'Unlock'}</Button>
                    {recordLock(record).kind === 'cltv_time' && <Button danger disabled={props.busy || props.recordErrors.length > 0} onClick={() => props.onUnlock(record, true)}>Test Unlock (skip MTP)</Button>}
                  </Space>]
                  : [<Tag key="unlocked" color="success">Unlocked</Tag>]}
            >
              <List.Item.Meta
                title={<Space wrap><Tag color={record.assetKind === 'runes' ? 'purple' : 'blue'}>{record.assetKind === 'runes' ? 'Rune' : 'BRC-20'}</Tag><strong>{record.runeName || record.ticker}</strong>{record.runeId && <Tag>{record.runeId}</Tag>}<Tag>{record.amount}</Tag><Tag className="lock-condition-tag" color="blue">{describeLock(recordLock(record))}</Tag>{record.chain && <Tag>{record.chain}</Tag>}{record.status === 'pending' && <Tag color="processing">Broadcast {record.broadcastStep || 0}/5</Tag>}{record.status === 'unlocked' && <Tag color="success">Unlocked</Tag>}</Space>}
                description={<Space direction="vertical" size={2}>
                  {recordLock(record).kind === 'cltv_time' && <span>{cltvMaturityLabel(record, props.chainInfo)}</span>}
                  <span>Time-lock address: <a href={getAddressExplorerUrl(record.timeLockAddress, record.chain)} target="_blank" rel="noreferrer">{shortAddress(record.timeLockAddress, 12, 12)}</a></span>
                  {record.assetKind === 'runes'
                    ? <span>Lock transaction: <a href={getTransactionExplorerUrl(record.commitTxid, record.chain)} target="_blank" rel="noreferrer">{shortAddress(record.commitTxid, 12, 12)}</a></span>
                    : record.status === 'pending'
                      ? <span>Broadcast progress: {record.broadcastStep || 0}/5 transactions submitted</span>
                      : <span>Inscription outpoint: <a href={getTransactionExplorerUrl(record.inscriptionTxid, record.chain)} target="_blank" rel="noreferrer">{shortAddress(record.inscriptionTxid, 12, 12)}:{record.inscriptionVout}</a></span>}
                  {record.initialCommitTxid && (record.status !== 'pending' || (record.broadcastStep || 0) >= 1) && <span>1/5 Self transfer commit: <a href={getTransactionExplorerUrl(record.initialCommitTxid, record.chain)} target="_blank" rel="noreferrer">{shortAddress(record.initialCommitTxid, 12, 12)}</a></span>}
                  {record.initialRevealTxid && (record.status !== 'pending' || (record.broadcastStep || 0) >= 2) && <span>2/5 Self transfer reveal: <a href={getTransactionExplorerUrl(record.initialRevealTxid, record.chain)} target="_blank" rel="noreferrer">{shortAddress(record.initialRevealTxid, 12, 12)}</a></span>}
                  {record.transferToLockTxid && (record.status !== 'pending' || (record.broadcastStep || 0) >= 3) && <span>3/5 Send to time lock: <a href={getTransactionExplorerUrl(record.transferToLockTxid, record.chain)} target="_blank" rel="noreferrer">{shortAddress(record.transferToLockTxid, 12, 12)}</a></span>}
                  {record.lockCommitTxid && (record.status !== 'pending' || (record.broadcastStep || 0) >= 4) && <span>4/5 Time-lock transfer commit: <a href={getTransactionExplorerUrl(record.lockCommitTxid, record.chain)} target="_blank" rel="noreferrer">{shortAddress(record.lockCommitTxid, 12, 12)}</a></span>}
                  {record.lockRevealTxid && (record.status !== 'pending' || (record.broadcastStep || 0) >= 5) && <span>5/5 Time-lock transfer reveal: <a href={getTransactionExplorerUrl(record.lockRevealTxid, record.chain)} target="_blank" rel="noreferrer">{shortAddress(record.lockRevealTxid, 12, 12)}</a></span>}
                  {record.unlockTxid && <span>Unlock transaction: <a href={getTransactionExplorerUrl(record.unlockTxid, record.chain)} target="_blank" rel="noreferrer">{shortAddress(record.unlockTxid, 12, 12)}</a></span>}
                  <span>Created: {new Date(record.createdAt).toLocaleString()}</span>
                </Space>}
              />
            </List.Item>
          )}
        />
      </Card>
    </>
  )
}
