import type { SessionBackendKind } from '../../../src/core/sessions/types.js'
import commandCodeMark from '../../../ios/Sources/Milo/Resources/provider-commandcode.png'
import { MiloMark } from './MiloMark.js'

export function SessionBackendMark({ backend, size = 18, className = '' }: {
  backend: SessionBackendKind
  size?: number
  className?: string
}) {
  if (backend !== 'command-code') {
    return <MiloMark size={size} className={`session-backend-mark ${className}`.trim()} />
  }
  return <img
    className={`session-backend-mark ${className}`}
    src={commandCodeMark}
    width={size}
    height={size}
    alt=""
    aria-hidden="true"
    draggable={false}
  />
}
