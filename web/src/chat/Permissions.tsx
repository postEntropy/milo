import { useEffect, useState } from 'react'
import type { PermissionRequest } from '@protocol'
import { toolApprovalTitle } from '../../../src/gateways/tool-line.ts'
import { Icon } from '../ui/Icons.js'

export function Permissions({ request, expiresAt, onDecision }: {
  request: PermissionRequest
  expiresAt: number
  /** `always` covers the same act for the rest of this session. */
  onDecision(action: 'allow' | 'always' | 'deny'): void
}) {
  const title = toolApprovalTitle(request.tool)
  const [remaining, setRemaining] = useState(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
  useEffect(() => {
    const update = () => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  return <section className="approval" aria-label={title}>
    <div className="approval-head">
      <span className="approval-icon"><Icon name="shield" /></span>
      <div className="approval-title"><span className="approval-eyebrow">Approval needed</span><h2>{title}</h2><p>Review the action before letting it happen.</p></div>
    </div>
    <pre className="approval-command">{request.summary}</pre>
    {request.approvalScope && <p>{request.approvalScope}</p>}
    <div className="approval-actions">
      <button className="allow-button" type="button" onClick={() => onDecision('allow')}><Icon name="check" size={15} /> Allow</button>
      {request.approvalScope && <button className="always-button" type="button" onClick={() => onDecision('always')}>Allow for session</button>}
      <button className="deny-button" type="button" onClick={() => onDecision('deny')}>Deny</button>
      <span className="approval-time"><Icon name="clock" size={14} /> {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>
    </div>
  </section>
}
