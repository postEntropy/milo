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

/**
 * Where a panel artifact is fetched, inline rather than as a download: the panel
 * frames an HTML page or a PDF and shows an image, so the server serves it with
 * the disposition the page needs. It shares the attachment id space — the same
 * files, drawn differently.
 */
export function panelUrl(id: string): string {
  return `/panel/${encodeURIComponent(id)}?t=${encodeURIComponent(apiToken())}`
}

/** The live browser as an MJPEG stream, drawn directly in an `<img>`. */
export function browserFramesUrl(): string {
  return `/browser/frames?t=${encodeURIComponent(apiToken())}`
}

export async function api<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json() as T | { error?: string }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : response.statusText
    throw new ApiError(error, response.status)
  }
  return payload as T
}

export async function uploadFile(file: File): Promise<string> {
  const response = await fetch('/upload', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken()}`,
      'content-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  })
  const payload = await response.json() as { uploadId?: string; error?: string }
  if (!response.ok || !payload.uploadId) throw new ApiError(payload.error ?? response.statusText, response.status)
  return payload.uploadId
}
