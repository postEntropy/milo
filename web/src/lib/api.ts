export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const TOKEN_KEY = 'milo-token'

/**
 * The token the server printed, taken out of the URL once and kept on the device.
 * It outlives the tab on purpose: a page added to the home screen opens at the
 * app's root, with no `?t=` on it, and would otherwise have nothing to present.
 */
export function apiToken(): string {
  const params = new URLSearchParams(location.search)
  const fromUrl = params.get('t')
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl)
    params.delete('t')
    const search = params.toString()
    history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`)
  }
  return localStorage.getItem(TOKEN_KEY) ?? ''
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
