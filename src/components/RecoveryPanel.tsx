import { useEffect, useState } from 'react'
import { Alert, Button, Card, Checkbox, Descriptions, Input, List, Modal, Select, Space, Tag, Typography } from 'antd'
import { ChainType } from '../types'
import { CHAIN_OPTIONS } from '../lib/chain'
import { getTransactionExplorerUrl } from '../lib/explorer'
import { describeLock } from '../lib/lock-date'
import { getMetadataLockCondition } from '../lib/recovery'
import type { RecoveryInspection } from '../lib/recovery-chain'
import type { RecoveryController } from '../hooks/useRecovery'

function assets(inspection: RecoveryInspection): string {
  if (inspection.assets?.kind === 'brc20') return `${inspection.assets.amount} ${inspection.assets.ticker} (BRC-20 transfer)`
  if (inspection.assets?.kind === 'runes') return inspection.assets.balances.map((balance) => `${balance.amount} base units of ${balance.spacedRune || balance.rune || balance.runeid}`).join('; ')
  return `${inspection.assetKind === 'brc20' ? 'BRC-20' : 'Runes'} carrier; asset state unknown`
}

export function RecoveryPanel({ controller: c }: { controller: RecoveryController }) {
  const [feeAcknowledged, setFeeAcknowledged] = useState(false)
  const [retryAcknowledged, setRetryAcknowledged] = useState(false)
  useEffect(() => { setFeeAcknowledged(false); setRetryAcknowledged(false) }, [c.confirmation])
  const disabled = c.busy || !!c.snapshot.errors.length || !!c.legacyErrors.length
  const inscribeUrl = c.chain === ChainType.BITCOIN_MAINNET ? 'https://unisat.io/inscribe'
    : c.chain === ChainType.FRACTAL_BITCOIN_MAINNET ? 'https://fractal.unisat.io/inscribe' : undefined
  const review = c.confirmation
  return (
    <Card title="4. Public backup & recovery" className="tool-card recovery-panel">
      <section aria-label="Public backup and recovery">
        <Typography.Paragraph>
          Recover a lost local reference from its lock transaction or a public backup. Reading and restoring references does not ask your wallet to sign or send funds. Only the original owner can unlock a mature lock.
        </Typography.Paragraph>
        <label className="field-label" htmlFor="recovery-chain">Recovery network</label>
        <Select id="recovery-chain" className="full" value={c.chain} placeholder="Select the original network explicitly" disabled={c.busy}
          options={CHAIN_OPTIONS.map((option) => ({ ...option, label: `${option.label} — recovery` }))}
          onChange={(chain: ChainType) => c.patch({ chain })} />
        <span className="field-hint">This selection does not switch your wallet. {c.workspace.toUpperCase()} references only; use the other workspace for its lock kind.</span>
        {!c.hasApiKey && <Alert className="mt-16" type="info" showIcon message="Configure the UniSat OpenAPI key above to read chain evidence. No wallet connection is required to restore references." />}
        {[...c.snapshot.errors, ...c.legacyErrors].map((error, index) => <Alert key={index} className="mt-16" type="error" showIcon message="Recovery changes blocked" description={error} />)}
        <div className="recovery-tools mt-16">
          <div className="recovery-section">
            <Typography.Title level={5}>Restore public references</Typography.Title>
            <label className="field-label" htmlFor="recovery-source">Read from</label>
            <Select id="recovery-source" className="full" value={c.draft.mode} disabled={c.busy} onChange={(mode) => c.patch({ mode })}
              options={[{ value: 'txid', label: 'Original lock transaction ID' }, { value: 'manifest', label: 'Public JSON text or file' }, { value: 'inscription', label: 'Backup inscription ID' }]} />
            {c.draft.mode === 'txid' && <div className="mt-16">
              <label className="field-label" htmlFor="recovery-txid">Lock transaction ID (optional :vout)</label>
              <Input id="recovery-txid" value={c.draft.txid} disabled={c.busy} onChange={(event) => c.patch({ txid: event.target.value })} placeholder="64-character transaction ID" autoComplete="off" />
            </div>}
            {c.draft.mode === 'manifest' && <div className="mt-16">
              <label className="field-label" htmlFor="recovery-manifest">Public recovery JSON</label>
              <Input.TextArea id="recovery-manifest" value={c.draft.manifest} disabled={c.busy} onChange={(event) => c.patch({ manifest: event.target.value })} rows={6} placeholder='{"format":"batl-recovery","version":1,...}' />
              <label className="field-label mt-16" htmlFor="recovery-file">Or choose a public JSON file (maximum 4096 bytes)</label>
              <input id="recovery-file" type="file" accept=".json,application/json,text/plain" disabled={c.busy} onChange={(event) => { void c.readFile(event.target.files?.[0]); event.target.value = '' }} />
            </div>}
            {c.draft.mode === 'inscription' && <div className="mt-16">
              <label className="field-label" htmlFor="recovery-inscription">Full backup inscription ID</label>
              <Input id="recovery-inscription" value={c.draft.inscription} disabled={c.busy} onChange={(event) => c.patch({ inscription: event.target.value })} placeholder="Transaction ID followed by i0" autoComplete="off" />
              <span className="field-hint">Plain JSON/text only. Remote content is parsed as data and is never rendered as HTML.</span>
            </div>}
            <Button className="mt-16" type="primary" disabled={disabled || !c.chain || !c.hasApiKey} onClick={() => void c.restore()}>Restore records</Button>
            <span className="field-hint">Up to 20 outpoints, checked sequentially. A public backup cannot resume an unfinished five-transaction BRC-20 broadcast.</span>
          </div>
          <div className="recovery-section">
            <Typography.Title level={5}>Export a public backup</Typography.Title>
            <Typography.Paragraph type="secondary">Only the format, version, network and selected outpoints are included. No API key, signature, signed PSBT, address or amount is exported.</Typography.Paragraph>
            <fieldset className="recovery-selection" disabled={disabled}>
              <legend className="field-label">Select references (maximum 20)</legend>
              {!c.backupOptions.length && <span className="field-hint">No eligible local or recovered references for this network and workspace.</span>}
              {c.backupOptions.map((option) => <Checkbox key={option.key} checked={c.draft.selected.includes(option.key)}
                disabled={disabled || (c.draft.selected.length >= 20 && !c.draft.selected.includes(option.key))}
                onChange={(event) => c.patch({ selected: event.target.checked ? [...c.draft.selected, option.key] : c.draft.selected.filter((key) => key !== option.key) })}>{option.label}</Checkbox>)}
            </fieldset>
            <Button className="mt-16" disabled={disabled || !c.draft.selected.length} onClick={() => void c.previewBackup()}>Preview public JSON</Button>
            {c.draft.preview && <div className="mt-16">
              <label className="field-label" htmlFor="recovery-preview">Exact public-only backup content</label>
              <Input.TextArea id="recovery-preview" value={c.draft.preview} readOnly rows={7} />
              <Alert className="mt-16" type="warning" showIcon message="Public and linkable, not a private backup"
                description="These outpoints permanently link the referenced transactions if you inscribe this file. Before paying to inscribe, verify the original lock and wait for confirmations. A confirmed backup inscription does not prove its referenced locks or assets are valid." />
              <Button className="mt-16" disabled={disabled} onClick={() => void c.downloadBackup()}>Download public backup</Button>
            </div>}
            <Typography.Paragraph className="mt-16">
              Download does not inscribe anything. To publish it, use UniSat yourself, select the same network, pay its fees and confirm in your wallet. Keep the final inscription ID offline. Sending the backup NFT to your own address can help you find it; owning that NFT does not grant the lock's signing authority.
            </Typography.Paragraph>
            {inscribeUrl ? <a href={inscribeUrl} target="_blank" rel="noreferrer">Open official UniSat inscription page</a>
              : <span className="field-hint">For test networks, choose the matching network yourself in the official UniSat interface; no inscription URL is assumed here.</span>}
          </div>
        </div>
        {c.draft.feedback && <Alert className="mt-16 recovery-feedback" type={c.draft.failed ? 'error' : 'info'} showIcon message={c.draft.feedback} />}
        <Typography.Title className="mt-16" level={5}>Recovered {c.workspace.toUpperCase()} references</Typography.Title>
        <Typography.Paragraph type="secondary">Indexer replies are evidence, not independent consensus proofs. “Last checked” can expire or change. Recovered references store no asset balance or spend authorization.</Typography.Paragraph>
        <List dataSource={c.records} rowKey={(record) => `${record.chain}:${record.txid}:${record.vout}`}
          locale={{ emptyText: 'No recovered references for the selected network and workspace.' }}
          renderItem={(reference) => {
            const state = c.rowState(reference)
            const inspection = state.inspection
            return <List.Item data-recovery-outpoint={`${reference.txid}:${reference.vout}`}>
              <div className="recovery-record">
                <div className="recovery-record-body">
                  <a className="recovery-outpoint" href={getTransactionExplorerUrl(reference.txid, reference.chain)} target="_blank" rel="noreferrer">{reference.txid}:{reference.vout}</a>
                  <div className="field-hint">{reference.chain} · Source: {reference.source} · Restored: {new Date(reference.restoredAt).toLocaleString()}</div>
                  {inspection ? <>
                    <div className="mt-16"><Tag color={inspection.verification === 'verified' ? 'blue' : inspection.verification === 'spent' ? 'red' : 'default'}>Last checked: {inspection.verification}</Tag><span>{new Date(inspection.checkedAt).toLocaleString()}</span></div>
                    <div>{describeLock(getMetadataLockCondition(inspection.metadata))}</div>
                    <div>{assets(inspection)}</div>
                    <div>Original owner: <span className="recovery-outpoint">{inspection.ownerAddress}</span></div>
                    <div>Lock address: <span className="recovery-outpoint">{inspection.timeLockAddress}</span></div>
                    {inspection.reason && <div className="field-hint">{inspection.reason}</div>}
                  </> : <div className="field-hint">Not checked in this session. Only the public reference is stored.</div>}
                  {reference.unlockTxid && <div className="mt-16">Previous prepared/sent attempt (outcome not assumed): <a className="recovery-outpoint" href={getTransactionExplorerUrl(reference.unlockTxid, reference.chain)} target="_blank" rel="noreferrer">{reference.unlockTxid}</a>. Check it on the original network before any retry.</div>}
                  {state.disabledReason && <div className="field-hint">{state.disabledReason}</div>}
                </div>
                <Space wrap className="recovery-record-actions">
                  <Button disabled={disabled || !c.hasApiKey} onClick={() => void c.verify(reference)}>Verify recovered record</Button>
                  <Button type="primary" disabled={!!state.disabledReason} onClick={() => void c.unlock(reference)}>{reference.unlockTxid ? 'Review & retry recovered unlock' : 'Review recovered unlock'}</Button>
                </Space>
              </div>
            </List.Item>
          }} />
        <Modal title={review?.previousAttempt ? 'Review an explicit recovered unlock retry' : 'Review recovered unlock transaction'} open={!!review} width={720}
          className="recovery-confirmation" onCancel={() => c.confirm(false)} footer={[
            <Button key="cancel" onClick={() => c.confirm(false)}>Cancel recovered unlock</Button>,
            <Button key="confirm" type="primary" disabled={!feeAcknowledged || (!!review?.previousAttempt && !retryAcknowledged)} onClick={() => c.confirm(true)}>Confirm recovered signing</Button>,
          ]}>
          {review && <Space direction="vertical" className="full" size="middle">
            <Alert type="warning" showIcon message="Your wallet will be asked to sign and broadcast a real unlock."
              description="All checks are repeated before signing and broadcast. Signature checks do not replace chain consensus or the asset indexer." />
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="Network">{review.inspection.chain}</Descriptions.Item>
              <Descriptions.Item label="Locked outpoint">{review.inspection.outpoint.txid}:{review.inspection.outpoint.vout}</Descriptions.Item>
              <Descriptions.Item label="Original lock">{describeLock(getMetadataLockCondition(review.inspection.metadata))}</Descriptions.Item>
              <Descriptions.Item label="Assets">{assets(review.inspection)}</Descriptions.Item>
              <Descriptions.Item label="Owner return address">{review.inspection.ownerAddress}</Descriptions.Item>
              <Descriptions.Item label="Full principal returned">{review.inspection.outpoint.satoshi} sat</Descriptions.Item>
              <Descriptions.Item label="Estimated network fee">{review.transaction.estimatedFee} sat (separate fee inputs)</Descriptions.Item>
            </Descriptions>
            <div className="full"><strong>Every selected fee input</strong><ol className="recovery-transaction-list">{review.transaction.feeInputs.map((input) => <li key={`${input.txid}:${input.vout}`}><span className="recovery-outpoint">{input.txid}:{input.vout}</span> — {input.satoshi} sat</li>)}</ol></div>
            <div className="full"><strong>Every output</strong><ol start={0} className="recovery-transaction-list">{review.transaction.outputs.map((output, index) => <li key={index}>{output.satoshi} sat — {output.type}<br /><span className="recovery-outpoint">{output.address}</span></li>)}</ol></div>
            <Checkbox checked={feeAcknowledged} onChange={(event) => setFeeAcknowledged(event.target.checked)}>I confirm these fee UTXOs contain no Alkanes or other assets not covered by the inscription and Runes checks.</Checkbox>
            {review.previousAttempt && <>
              <Alert type="warning" showIcon message="Previous attempt must be checked before retrying"
                description={<span>Previous transaction: <a className="recovery-outpoint" href={getTransactionExplorerUrl(review.previousAttempt, review.inspection.chain)} target="_blank" rel="noreferrer">{review.previousAttempt}</a>. It may already be broadcast. The old and new transactions can compete for the same locked input; only one can become valid.</span>} />
              <Checkbox checked={retryAcknowledged} onChange={(event) => setRetryAcknowledged(event.target.checked)}>I checked the previous attempt on the original network and explicitly want to review a new signing attempt.</Checkbox>
            </>}
          </Space>}
        </Modal>
      </section>
    </Card>
  )
}
