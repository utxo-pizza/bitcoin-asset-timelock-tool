import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { AssetKind, ResultState, TimeLockCondition } from '../types'
import { DEFAULT_FEE_RATE } from '../constants'

export type LockWorkspace = 'csv' | 'cltv'
export type WorkspaceDraft = {
  ticker: string
  amount: string
  assetKind: AssetKind
  runeReference: string
  lockBlocks: number
  lockDate: string
  feeRate: number
  feeRateManuallySet: boolean
  result: ResultState
}
export type WorkspaceDrafts = Record<LockWorkspace, WorkspaceDraft>

export function workspaceFromHash(hash: string): LockWorkspace {
  return hash === '#/cltv' ? 'cltv' : 'csv'
}

export function workspaceLockKind(workspace: LockWorkspace): TimeLockCondition['kind'] {
  return workspace === 'csv' ? 'csv_blocks' : 'cltv_time'
}

export function initialWorkspaceDrafts(): WorkspaceDrafts {
  const empty = (): WorkspaceDraft => ({ ticker: '', amount: '', assetKind: 'brc20', runeReference: '', lockBlocks: 3, lockDate: '', feeRate: DEFAULT_FEE_RATE, feeRateManuallySet: false, result: { status: 'idle' } })
  return { csv: empty(), cltv: empty() }
}

export function patchWorkspaceDraft(drafts: WorkspaceDrafts, workspace: LockWorkspace, patch: Partial<WorkspaceDraft>): WorkspaceDrafts {
  return { ...drafts, [workspace]: { ...drafts[workspace], ...patch } }
}

export function withRecommendedFee(drafts: WorkspaceDrafts, feeRate: number): WorkspaceDrafts {
  return {
    csv: drafts.csv.feeRateManuallySet ? drafts.csv : { ...drafts.csv, feeRate },
    cltv: drafts.cltv.feeRateManuallySet ? drafts.cltv : { ...drafts.cltv, feeRate },
  }
}

/** One wallet app, two in-memory workspaces. Async setters stay bound to their origin page. */
export function useLockWorkspaces(navigationBlocked: MutableRefObject<boolean>) {
  const [workspace, setWorkspace] = useState(() => workspaceFromHash(window.location.hash))
  const workspaceRef = useRef(workspace)
  const [drafts, setDrafts] = useState(initialWorkspaceDrafts)

  useEffect(() => {
    const onHashChange = () => {
      const next = navigationBlocked.current ? workspaceRef.current : workspaceFromHash(window.location.hash)
      const canonical = `#/${next}`
      if (window.location.hash !== canonical) window.history.replaceState(null, '', canonical)
      workspaceRef.current = next
      setWorkspace(next)
    }
    onHashChange()
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [navigationBlocked])

  const updateDraft = useCallback((patch: Partial<WorkspaceDraft>) => {
    setDrafts((current) => patchWorkspaceDraft(current, workspace, patch))
  }, [workspace])
  const setResult = useCallback((result: ResultState) => {
    setDrafts((current) => patchWorkspaceDraft(current, workspace, { result }))
  }, [workspace])
  const clearResults = useCallback(() => {
    setDrafts((current) => ({ csv: { ...current.csv, result: { status: 'idle' } }, cltv: { ...current.cltv, result: { status: 'idle' } } }))
  }, [])
  const applyRecommendedFee = useCallback((feeRate: number) => setDrafts((current) => withRecommendedFee(current, feeRate)), [])
  const resetFeeOverrides = useCallback(() => {
    setDrafts((current) => ({ csv: { ...current.csv, feeRateManuallySet: false }, cltv: { ...current.cltv, feeRateManuallySet: false } }))
  }, [])

  return { workspace, draft: drafts[workspace], updateDraft, setResult, clearResults, applyRecommendedFee, resetFeeOverrides }
}
