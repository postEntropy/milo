export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const TOKEN_KEY = 'milo-token'

/**
 * The token the server printed, kept on the device and left in the address bar.
 *
 * It has to stay in the URL. An iPhone's home-screen app runs in a storage of its
 * own, so the token a Safari tab writes never reaches it — the address the page
 * was added from is the only thing that carries over. That is also why the
 * manifest declares no `start_url`: the installed app opens at that address.
 */
export function apiToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('t')
  if (fromUrl) localStorage.setItem(TOKEN_KEY, fromUrl)
  return fromUrl ?? localStorage.getItem(TOKEN_KEY) ?? ''
}

/**
 * A screen's address with the token still on it, for the paths the app writes to
 * the address bar. Without it, navigating away drops the token and an icon added
 * from that screen would open with nothing to present.
 */
export function withToken(path: string): string {
  const token = apiToken()
  return token ? `${path}?t=${encodeURIComponent(token)}` : path
}

/**
 * Where a delivered file is fetched. The id is all the server will accept — it
 * knows what it delivered and serves nothing else — and the token rides in the
 * query because an `<img>` sends no header.
 */
export function attachmentUrl(id: string): string {
  return `/attachment/${encodeURIComponent(id)}?t=${encodeURIComponent(apiToken())}`
}

/** Authorization header for direct `fetch` calls so the token stays out of URLs. */
export function authHeaders(): Record<string, string> {
  const token = apiToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

/** Where a panel document is fetched via `fetch()` with an Authorization header. */
export function panelApiUrl(id: string): string {
  return `/panel/${encodeURIComponent(id)}`
}

/** Where an expanded Computer Use tool preview is fetched via authenticated `fetch()`. */
export function toolPreviewUrl(id: string, callId: string, sessionId: string): string {
  const params = new URLSearchParams({ callId, sessionId })
  return `/api/tool-preview/${encodeURIComponent(id)}?${params.toString()}`
}

/** Where a panel artifact (`<img>` or `<iframe>`) is fetched via an artifact-scoped ticket. */
export function panelTicketUrl(id: string, ticket: string): string {
  return `/panel/${encodeURIComponent(id)}?p=${encodeURIComponent(ticket)}`
}

/** Mints an artifact-scoped ticket so framed panel HTML never receives the bearer token. */
export async function issuePanelTicket(id: string): Promise<string> {
  const result = await api<{ ticket: string }>('panel-ticket', { id })
  return result.ticket
}

/** The live browser as an MJPEG stream, drawn directly in an `<img>`. */
export function browserFramesUrl(): string {
  return `/browser/frames?t=${encodeURIComponent(apiToken())}`
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function api<T>(action: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${action}`, {
    method: 'POST',
    signal,
    headers: {
      ...authHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await readJsonSafe(response)
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : response.statusText || `HTTP ${response.status}`
    throw new ApiError(error, response.status)
  }
  if (payload === null) throw new ApiError('Server returned an unreadable response.', response.status)
  return payload as T
}

export async function uploadFile(file: File): Promise<string> {
  const response = await fetch('/upload', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'content-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  })
  const payload = await readJsonSafe(response) as { uploadId?: string; error?: string } | null
  const error = payload && typeof payload.error === 'string' ? payload.error : response.statusText || `HTTP ${response.status}`
  if (!response.ok || !payload?.uploadId) throw new ApiError(error, response.status)
  return payload.uploadId
}
