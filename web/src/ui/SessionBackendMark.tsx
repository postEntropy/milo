import type { SessionBackendKind } from '../../../src/core/sessions/types.js'
import miloMark from '../../../assets/milo-mark-transparent.png'
import commandCodeMark from '../../../ios/Sources/Milo/Resources/provider-commandcode.png'

export function SessionBackendMark({ backend, size = 18, className = '' }: {
  backend: SessionBackendKind
  size?: number
  className?: string
}) {
  return <img
    className={`session-backend-mark ${className}`}
    src={backend === 'command-code' ? commandCodeMark : miloMark}
    width={size}
    height={size}
    alt=""
    aria-hidden="true"
    draggable={false}
  />
}
