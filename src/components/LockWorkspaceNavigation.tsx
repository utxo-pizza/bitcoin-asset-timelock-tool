import type { LockWorkspace } from '../hooks/useLockWorkspaces'

export function LockWorkspaceNavigation({ workspace, busy }: { workspace: LockWorkspace; busy: boolean }) {
  return <nav className="workspace-navigation" aria-label="Lock workspaces">
    {(['csv', 'cltv'] as const).map((item) => <a
      key={item}
      href={`#/${item}`}
      aria-current={workspace === item ? 'page' : undefined}
      aria-disabled={busy}
      tabIndex={busy ? -1 : 0}
      onClick={(event) => { if (busy) event.preventDefault() }}
    >
      <strong>{item.toUpperCase()}</strong>
      <span>{item === 'csv' ? 'Relative block locks' : 'Fixed UTC date locks'}</span>
    </a>)}
    {busy && <span className="workspace-navigation-status" role="status">Finish or cancel the current operation before switching workspaces.</span>}
  </nav>
}
