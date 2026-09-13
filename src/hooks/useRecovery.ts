import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChainType, TimeLockRecord } from '../types'
import type { LockWorkspace } from './useLockWorkspaces'
import { workspaceLockKind } from './useLockWorkspaces'
import { parseBlockchainInfo, requireKnownChain, CHAIN_SNAPSHOT_TTL_MS, type BlockchainInfo } from '../lib/openapi'
import { RECOVERED_RECORDS_KEY, getCurrentRecoveredReference, readRecoveredSnapshot, recoveryKey, saveRecoveredReference, updateRecoveredReference, type RecoveryReference } from '../lib/recovered-records'
import { assertRecordsWritable, readRecords, recordLock, RECORDS_KEYS } from '../lib/records'
import { assertRecoveryFresh, assertRecoveryOwner, getVerifiedRecoveryFunding, inspectRecoveryOutpoint, verifyRecoveryFunding, type RecoveryInspection } from '../lib/recovery-chain'
import { loadRecoveryManifestInscription, requestRecoveryData } from '../lib/recovery-api'
import { getMetadataLockCondition } from '../lib/recovery'
import { MAX_PUBLIC_RECOVERY_BYTES, MAX_PUBLIC_RECOVERY_OUTPOINTS, parsePublicRecoveryManifest, serializePublicRecoveryManifest } from '../lib/recovery-manifest'
import { assertRecoveryMature, executeRecoveryUnlock, type RecoveryUnlockReview } from '../lib/recovery-unlock'
import { freezeOperationIdentity, pushSignedPsbt, signPsbtCompat, type OperationIdentity } from '../lib/wallet'

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
type Draft = { chain?: ChainType; mode: 'txid' | 'manifest' | 'inscription'; txid: string; manifest: string; inscription: string; selected: string[]; preview: string; feedback: string; failed: boolean }
type Check = { inspection?: RecoveryInspection; info?: BlockchainInfo; context: string }
type Options = {
  workspace: LockWorkspace; busy: boolean; feeRate: number
  wallet: { connected: boolean; address: string; pubKey: string; chain: ChainType | string }
  apiKey: string; hasApiKey: boolean; legacyRecords: TimeLockRecord[]; legacyErrors: string[]
  storage: StoragePort; operationGate: { enter: () => boolean; leave: () => void }
  setBusy: (busy: boolean) => void; setLoadingText: (text: string) => void
  watchIdentity: (identity: OperationIdentity) => { assertCurrent: () => Promise<void>; dispose: () => void }
}

function blankDraft(): Draft { return { mode: 'txid', txid: '', manifest: '', inscription: '', selected: [], preview: '', feedback: '', failed: false } }
function keyOf(reference: Pick<RecoveryReference, 'chain' | 'txid' | 'vout'>): string { return recoveryKey(reference.chain, reference.txid, reference.vout) }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'Recovery operation failed.' }
function knownChain(value: string): ChainType | undefined { try { return requireKnownChain(value) } catch { return undefined } }
async function recoveryChainInfo(chain: ChainType, apiKey: string): Promise<BlockchainInfo> {
  const startedAt = Date.now()
  return parseBlockchainInfo(await requestRecoveryData('/blockchain/info', chain, apiKey), chain, startedAt)
}

export function useRecovery(options: Options) {
  const { workspace, wallet, storage } = options
  const [drafts, setDrafts] = useState<Record<LockWorkspace, Draft>>(() => ({ csv: blankDraft(), cltv: blankDraft() }))
  const draft = drafts[workspace]
  const chain = draft.chain ?? knownChain(wallet.chain)
  const [snapshot, setSnapshot] = useState(() => readRecoveredSnapshot(storage))
  const [checks, setChecks] = useState<Record<string, Check>>({})
  const [now, setNow] = useState(Date.now)
  const [confirmation, setConfirmation] = useState<RecoveryUnlockReview | null>(null)
  const confirmationResolver = useRef<((confirmed: boolean) => void) | null>(null)
  const epoch = useRef(0)
  // Primitive context only: our own busy/confirmation renders must not invalidate work.
  const context = useMemo(() => JSON.stringify([workspace, chain, wallet.connected, wallet.address, wallet.pubKey, wallet.chain, options.apiKey]),
    [workspace, chain, wallet.connected, wallet.address, wallet.pubKey, wallet.chain, options.apiKey])
  const activeContext = useRef(context)
  if (activeContext.current !== context) { activeContext.current = context; epoch.current += 1 }
  const patch = (update: Partial<Draft>, target = workspace) => setDrafts((current) => ({ ...current, [target]: { ...current[target], ...update } }))
  const refresh = () => setSnapshot(readRecoveredSnapshot(storage))
  useEffect(() => {
    setChecks({})
    setDrafts((current) => ({ ...current, [workspace]: { ...current[workspace], preview: '', selected: [] } }))
  }, [context, workspace])
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === RECOVERED_RECORDS_KEY || RECORDS_KEYS.some((key) => key === event.key)) {
        epoch.current += 1; setSnapshot(readRecoveredSnapshot(storage)); setChecks({})
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [storage])
  useEffect(() => {
    const provider = window.unisat
    const invalidate = () => { epoch.current += 1; setChecks({}) }
    provider?.on?.('accountsChanged', invalidate); provider?.on?.('chainChanged', invalidate)
    return () => { provider?.removeListener?.('accountsChanged', invalidate); provider?.removeListener?.('chainChanged', invalidate) }
  }, [wallet.connected])
  useEffect(() => {
    const expiries = Object.values(checks).map((check) => check.inspection?.checkedAt).filter((value): value is number => value !== undefined)
      .map((value) => value + CHAIN_SNAPSHOT_TTL_MS + 1).filter((value) => value > now)
    if (!expiries.length) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(...expiries) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [checks, now])
  useEffect(() => () => { epoch.current += 1; confirmationResolver.current?.(false) }, [])

  const assertStorage = (reference?: RecoveryReference) => {
    assertRecordsWritable(storage)
    const recovered = readRecoveredSnapshot(storage)
    if (recovered.errors.length) throw new Error(recovered.errors.join(' '))
    if (reference) {
      getCurrentRecoveredReference(reference, storage)
      const duplicate = readRecords(storage).records.some((item) => item.chain === reference.chain
        && item.inscriptionTxid.toLowerCase() === reference.txid && item.inscriptionVout === reference.vout)
      if (duplicate) throw new Error('This outpoint has an original local record. Use that record; no duplicate recovery unlock is allowed.')
    }
  }
  const run = async (action: (assertContext: () => void) => Promise<void>) => {
    if (!options.operationGate.enter()) return
    const token = epoch.current
    options.setBusy(true)
    patch({ feedback: '', failed: false })
    const assertContext = () => {
      if (activeContext.current !== context || epoch.current !== token) throw new Error('Wallet, network, API configuration, workspace or local records changed. The previous result was discarded.')
    }
    try { assertContext(); await action(assertContext) }
    catch (error) { patch({ feedback: errorText(error), failed: true }) }
    finally { refresh(); options.operationGate.leave(); options.setBusy(false); options.setLoadingText('') }
  }

  const records = snapshot.records.filter((reference) => reference.lockKind === workspaceLockKind(workspace) && reference.chain === chain)
  const backupOptions = useMemo(() => {
    if (!chain) return []
    const candidates: { key: string; txid: string; vout: number; label: string }[] = []
    for (const record of options.legacyRecords) {
      if (record.chain !== chain || record.status !== 'locked' || record.pendingPsbts || recordLock(record).kind !== workspaceLockKind(workspace)) continue
      try {
        const key = recoveryKey(chain, record.inscriptionTxid, record.inscriptionVout)
        candidates.push({ key, txid: record.inscriptionTxid.toLowerCase(), vout: record.inscriptionVout,
          label: `${record.runeName || record.ticker} — ${record.inscriptionTxid.slice(0, 12)}…:${record.inscriptionVout} (local broadcast record)` })
      } catch { /* Incomplete legacy references are not exportable. */ }
    }
    for (const reference of snapshot.records) {
      if (reference.chain !== chain || reference.lockKind !== workspaceLockKind(workspace)) continue
      candidates.push({ key: keyOf(reference), txid: reference.txid, vout: reference.vout,
        label: `Recovered reference — ${reference.txid.slice(0, 12)}…:${reference.vout}` })
    }
    return candidates.filter((item, index) => candidates.findIndex((other) => other.key === item.key) === index)
  }, [chain, workspace, options.legacyRecords, snapshot.records])

  const restore = () => run(async (assertContext) => {
    if (!chain || !options.hasApiKey) throw new Error('Select a recovery network and configure the OpenAPI key first.')
    assertStorage()
    let outpoints: { txid: string; vout?: number }[]
    if (draft.mode === 'txid') {
      const match = draft.txid.trim().match(/^([0-9a-f]{64})(?::(0|[1-9]\d{0,9}))?$/i)
      if (!match || (match[2] !== undefined && Number(match[2]) > 0xffffffff)) throw new Error('Enter a full transaction ID, optionally followed by :vout.')
      outpoints = [{ txid: match[1].toLowerCase(), ...(match[2] === undefined ? {} : { vout: Number(match[2]) }) }]
    } else {
      const manifest = draft.mode === 'manifest' ? parsePublicRecoveryManifest(draft.manifest)
        : await loadRecoveryManifestInscription(draft.inscription, chain, options.apiKey)
      assertContext()
      if (manifest.chain !== chain) throw new Error('The public manifest names a different network. Select that network explicitly.')
      outpoints = manifest.outpoints
    }
    const inspected: RecoveryInspection[] = []
    for (const outpoint of outpoints) {
      assertContext()
      const result = await inspectRecoveryOutpoint({ ...outpoint, chain, apiKey: options.apiKey, verifyAssets: false })
      assertContext()
      if (getMetadataLockCondition(result.metadata).kind !== workspaceLockKind(workspace)) throw new Error('The batch includes a different lock workspace. Nothing from this batch was saved; switch to its CSV or CLTV page.')
      if (readRecords(storage).records.some((record) => record.chain === chain && record.inscriptionTxid.toLowerCase() === result.outpoint.txid && record.inscriptionVout === result.outpoint.vout)) {
        throw new Error('This outpoint already has an original local record. Use the original record; no recovery history was fabricated.')
      }
      inspected.push(result)
    }
    assertContext(); assertStorage()
    let saved = 0
    try {
      for (const result of inspected) {
        assertContext()
        if (readRecords(storage).records.some((record) => record.chain === chain && record.inscriptionTxid.toLowerCase() === result.outpoint.txid && record.inscriptionVout === result.outpoint.vout)) {
          throw new Error('An original local record appeared during import. Use that record; no duplicate was saved.')
        }
        const reference: RecoveryReference = { schemaVersion: 1, chain, txid: result.outpoint.txid, vout: result.outpoint.vout,
          lockKind: workspaceLockKind(workspace), source: draft.mode, restoredAt: Date.now() }
        saveRecoveredReference(reference, storage)
        saved += 1
        setChecks((current) => ({ ...current, [keyOf(reference)]: { inspection: result, context } }))
      }
    } catch (error) { throw new Error(`${saved} of ${inspected.length} references processed before storage failed; any saved references were retained. ${errorText(error)}`) }
    patch({ feedback: `${saved} public reference${saved === 1 ? '' : 's'} restored. Lock scripts matched; assets, unspent state and maturity still require Verify. No signature or broadcast was requested.` })
  })

  const verify = (reference: RecoveryReference) => run(async (assertContext) => {
    if (!options.hasApiKey) throw new Error('Configure the OpenAPI key before checking recovery evidence.')
    assertStorage(reference)
    // A failed new check must not leave the previous successful result actionable.
    setChecks((current) => { const next = { ...current }; delete next[keyOf(reference)]; return next })
    const inspection = await inspectRecoveryOutpoint({ chain: reference.chain, txid: reference.txid, vout: reference.vout, apiKey: options.apiKey })
    assertContext(); assertStorage(reference)
    if (getMetadataLockCondition(inspection.metadata).kind !== reference.lockKind) throw new Error('Recovered lock kind does not match this workspace.')
    let info: BlockchainInfo | undefined
    if (inspection.verification === 'verified') {
      info = await recoveryChainInfo(reference.chain, options.apiKey)
      assertContext(); assertStorage(reference)
    }
    setChecks((current) => ({ ...current, [keyOf(reference)]: { inspection, info, context } }))
    setNow(Date.now())
    patch({ feedback: 'Last check updated. This is indexer evidence at a point in time, not a guarantee; unlock rechecks before signing and broadcast.' })
  })

  const rowState = (reference: RecoveryReference) => {
    const check = checks[keyOf(reference)]?.context === context ? checks[keyOf(reference)] : undefined
    let disabledReason = ''
    try {
      if (options.busy) throw new Error('Another operation is in progress.')
      if (options.legacyErrors.length || snapshot.errors.length) throw new Error('Local records are damaged; changes and unlock are blocked.')
      if (!options.hasApiKey) throw new Error('Configure the OpenAPI key first.')
      if (!check?.inspection) throw new Error('Verify this reference before reviewing an unlock.')
      assertRecoveryFresh(check.inspection, Math.max(now, Date.now()))
      if (!wallet.connected) throw new Error('Connect the original owner wallet to unlock.')
      assertRecoveryOwner(check.inspection, wallet.address, wallet.pubKey, wallet.chain)
      if (!check.info) throw new Error('Chain maturity is unknown. Verify again.')
      assertRecoveryMature(check.inspection, check.info, Math.max(now, Date.now()))
      if (options.legacyRecords.some((item) => item.chain === reference.chain && item.inscriptionTxid.toLowerCase() === reference.txid && item.inscriptionVout === reference.vout)) throw new Error('Use the existing original local record for this outpoint.')
    } catch (error) { disabledReason = errorText(error) }
    return { ...check, disabledReason }
  }

  const unlock = (reference: RecoveryReference) => run(async (assertContext) => {
    const check = checks[keyOf(reference)]
    if (!check?.inspection || check.context !== context || !wallet.connected || !options.hasApiKey || !chain) throw new Error('Verify this reference and connect its original owner wallet first.')
    const identity = freezeOperationIdentity(wallet.address, wallet.pubKey, chain, getMetadataLockCondition(check.inspection.metadata))
    const guard = options.watchIdentity(identity)
    try {
      const assertCurrent = async (expected: RecoveryReference) => {
        assertContext(); assertStorage(expected); await guard.assertCurrent(); assertContext(); assertStorage(expected)
      }
      const result = await executeRecoveryUnlock({ reference, address: identity.ownerAddress, pubKey: identity.pubKey, chain: identity.chain, feeRate: options.feeRate }, {
        assertCurrent,
        inspect: (expected) => inspectRecoveryOutpoint({ chain: expected.chain, txid: expected.txid, vout: expected.vout, apiKey: options.apiKey }),
        funding: (inspection) => getVerifiedRecoveryFunding(identity.ownerAddress, identity.pubKey, identity.chain, options.apiKey, inspection.outpoint),
        verifyFunding: (inputs, inspection) => verifyRecoveryFunding(inputs, identity.ownerAddress, identity.pubKey, identity.chain, options.apiKey, inspection.outpoint),
        chainInfo: () => recoveryChainInfo(identity.chain, options.apiKey),
        confirm: (review) => new Promise<boolean>((resolve) => { confirmationResolver.current = resolve; setConfirmation(review) }),
        sign: signPsbtCompat,
        saveAttempt: (expected, txid) => {
          assertContext(); assertStorage(expected)
          updateRecoveredReference(expected, { unlockTxid: txid }, storage)
          return getCurrentRecoveredReference({ ...expected, unlockTxid: txid }, storage)
        },
        broadcast: pushSignedPsbt,
        stage: options.setLoadingText,
        prepared: (txid) => patch({ feedback: `Prepared unlock transaction ID: ${txid}. Not yet a broadcast or confirmation.` }),
      })
      setChecks((current) => { const next = { ...current }; delete next[keyOf(reference)]; return next })
      patch({ feedback: result.kind === 'cancelled' ? 'Review cancelled. No signature or broadcast was requested.'
        : `Wallet reported broadcast of ${result.txid}. Confirmation and final asset balances have not been checked. Keep this transaction ID.` })
    } finally { guard.dispose(); confirmationResolver.current = null; setConfirmation(null) }
  })

  const confirm = (accepted: boolean) => { confirmationResolver.current?.(accepted); confirmationResolver.current = null; setConfirmation(null) }
  const makeBackup = () => {
    assertStorage()
    if (!chain || draft.selected.length < 1 || draft.selected.length > MAX_PUBLIC_RECOVERY_OUTPOINTS) throw new Error('Select 1–20 public outpoints for this network and workspace.')
    const freshLegacy = readRecords(storage)
    const freshRecovered = readRecoveredSnapshot(storage)
    const outpoints = draft.selected.map((key) => {
      const candidate = backupOptions.find((item) => item.key === key)
      if (!candidate) throw new Error('Backup selection changed. Select the current references again.')
      const original = freshLegacy.records.some((record) => record.chain === chain && record.status === 'locked' && !record.pendingPsbts
        && recordLock(record).kind === workspaceLockKind(workspace) && record.inscriptionTxid.toLowerCase() === candidate.txid && record.inscriptionVout === candidate.vout)
      const restored = freshRecovered.records.some((reference) => reference.chain === chain && reference.lockKind === workspaceLockKind(workspace) && keyOf(reference) === key)
      if (!original && !restored) throw new Error('A selected record changed. Rebuild the public preview.')
      return { txid: candidate.txid, vout: candidate.vout }
    })
    return serializePublicRecoveryManifest({ format: 'batl-recovery', version: 1, chain, outpoints })
  }
  const previewBackup = () => run(async () => { patch({ preview: makeBackup() }) })
  const downloadBackup = () => run(async () => {
    const text = makeBackup()
    if (!draft.preview || draft.preview !== text) throw new Error('Preview the current public-only selection before downloading.')
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `batl-recovery-${chain}-${workspace}.json`; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    patch({ feedback: 'Public JSON downloaded. It is not inscribed or backed up on-chain. Verify the original locks and wait for confirmations before paying to inscribe.' })
  })
  const readFile = async (file: File | undefined) => {
    if (!file || options.busy) return
    await run(async (assertContext) => {
      if (file.size > MAX_PUBLIC_RECOVERY_BYTES) throw new Error('Public recovery files must be at most 4096 bytes.')
      const text = await file.text(); assertContext(); parsePublicRecoveryManifest(text)
      patch({ manifest: text, mode: 'manifest', feedback: 'Public file loaded for review. Click Restore records to check its referenced locks.' })
    })
  }

  return { draft, chain, records, snapshot, backupOptions, confirmation, busy: options.busy,
    hasApiKey: options.hasApiKey, legacyErrors: options.legacyErrors, workspace, feeRate: options.feeRate,
    patch: (update: Partial<Draft>) => patch({ ...update, preview: '' }), rowState, restore, verify, unlock, confirm, readFile, previewBackup, downloadBackup }
}

export type RecoveryController = ReturnType<typeof useRecovery>
