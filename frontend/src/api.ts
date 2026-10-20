const TOKEN_KEY = 'bidverse.token'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = tokenStore.get()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(init.json)
  }

  const res = await fetch(`/api${path}`, { ...init, headers })
  if (res.status === 204) return undefined as T

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join('\n') : data?.message
    throw new ApiError(res.status, msg ?? `요청 실패 (${res.status})`)
  }
  return data as T
}
