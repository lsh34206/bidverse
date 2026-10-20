import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, tokenStore } from './api.ts'
import type { User } from './types.ts'

interface AuthResult {
  accessToken: string
  user: User
}

interface AuthContextValue {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, nickname: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(() => tokenStore.get() !== null)

  useEffect(() => {
    if (!tokenStore.get()) return
    api<User>('/auth/me')
      .then(setUser)
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false))
  }, [])

  const accept = useCallback((res: AuthResult) => {
    tokenStore.set(res.accessToken)
    setUser(res.user)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login: async (email, password) =>
        accept(await api<AuthResult>('/auth/login', { method: 'POST', json: { email, password } })),
      register: async (email, password, nickname) =>
        accept(
          await api<AuthResult>('/auth/register', {
            method: 'POST',
            json: { email, password, nickname },
          }),
        ),
      logout: () => {
        tokenStore.clear()
        setUser(null)
      },
    }),
    [user, loading, accept],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
