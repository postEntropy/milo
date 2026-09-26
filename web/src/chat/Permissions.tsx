import { useEffect, useState } from 'react'
import type { PermissionRequest } from '@protocol'
import { Icon } from '../ui/Icons.js'

export function Permissions({ request, expiresAt, onDecision }: {
  request: PermissionRequest
  expiresAt: number
  onDecision(allowed: boolean): void
}) {
  const [remaining, setRemaining] = useState(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  return <section className="approval" aria-label={`Approval needed for ${request.tool}`}>
    <div className="approval-head">
      <span className="approval-icon"><Icon name="shield" /></span>
      <div className="approval-title"><span className="approval-eyebrow">Approval needed</span><h2>Milo wants to run {request.tool}</h2><p>Review the action before letting it happen.</p></div>
    </div>
    <pre className="approval-command">{request.summary}</pre>
    <div className="approval-actions">
      <button className="allow-button" type="button" onClick={() => onDecision(true)}><Icon name="check" size={15} /> Allow</button>
      <button className="deny-button" type="button" onClick={() => onDecision(false)}>Deny</button>
      <span className="approval-time"><Icon name="clock" size={14} /> {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>
    </div>
  </section>
}
