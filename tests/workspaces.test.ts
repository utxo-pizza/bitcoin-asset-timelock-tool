import assert from 'node:assert/strict'
import test from 'node:test'
import { initialWorkspaceDrafts, patchWorkspaceDraft, withRecommendedFee, workspaceFromHash, workspaceLockKind } from '../src/hooks/useLockWorkspaces'

test('dedicated workspace hashes have explicit lock kinds and unknown routes default to CSV', () => {
  assert.equal(workspaceFromHash('#/cltv'), 'cltv')
  for (const hash of ['', '#/csv', '#/unknown', '#cltv']) assert.equal(workspaceFromHash(hash), 'csv')
  assert.equal(workspaceLockKind('csv'), 'csv_blocks')
  assert.equal(workspaceLockKind('cltv'), 'cltv_time')
})

test('CSV and CLTV begin with independent draft objects and keep the CSV default of three blocks', () => {
  const drafts = initialWorkspaceDrafts()
  assert.notEqual(drafts.csv, drafts.cltv)
  assert.notEqual(drafts.csv.result, drafts.cltv.result)
  assert.equal(drafts.csv.lockBlocks, 3)
  assert.equal(drafts.cltv.lockDate, '')
})

test('draft edits and late results only update their originating workspace', () => {
  let drafts = initialWorkspaceDrafts()
  drafts = patchWorkspaceDraft(drafts, 'csv', { ticker: 'CSV', amount: '12', feeRate: 7, lockBlocks: 144 })
  const csv = drafts.csv
  drafts = patchWorkspaceDraft(drafts, 'cltv', { assetKind: 'runes', runeReference: '840000:1', amount: '99', lockDate: '2040-01-01T00:00', result: { status: 'error', message: 'date-page error' } })
  assert.equal(drafts.csv, csv)
  const cltv = drafts.cltv
  drafts = patchWorkspaceDraft(drafts, 'csv', { result: { status: 'success', txid: 'synthetic', label: 'CSV lock' } })
  assert.equal(drafts.cltv, cltv)
  assert.equal(drafts.csv.amount, '12')
  assert.equal(drafts.csv.lockBlocks, 144)
})

test('recommended fees respect each workspace manual override at response time', () => {
  let drafts = initialWorkspaceDrafts()
  drafts = patchWorkspaceDraft(drafts, 'csv', { feeRate: 7, feeRateManuallySet: true })
  drafts = withRecommendedFee(drafts, 11)
  assert.equal(drafts.csv.feeRate, 7)
  assert.equal(drafts.cltv.feeRate, 11)
  drafts = patchWorkspaceDraft(drafts, 'cltv', { feeRate: 9, feeRateManuallySet: true })
  drafts = withRecommendedFee(drafts, 15)
  assert.equal(drafts.csv.feeRate, 7)
  assert.equal(drafts.cltv.feeRate, 9)
})
