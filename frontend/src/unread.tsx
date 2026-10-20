import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api.ts'
import { useAuth } from './auth.tsx'
import { useSocket } from './socket.tsx'
import type { NotifyEvent } from './types.ts'

interface UnreadValue {
  unread: number
  setUnread: (n: number | ((prev: number) => number)) => void
  refresh: () => Promise<void>
}

const UnreadContext = createContext<UnreadValue | null>(null)

/** 헤더의 종 아이콘과 알림 센터가 같은 안 읽은 알림 수를 보도록 공유한다. */
export function UnreadProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const socket = useSocket()
  const userId = user?.id
  const [unread, setUnread] = useState(0)

  const refresh = useCallback(async () => {
    if (!userId) return setUnread(0)
    try {
      setUnread((await api<{ unreadCount: number }>('/me/notifications/unread-count')).unreadCount)
    } catch {
      // 종 아이콘 숫자만 못 갱신될 뿐이라 조용히 넘어간다.
    }
  }, [userId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!socket || !userId) return
    // 저장된 알림(id가 있는 것)만 센다. 저장에 실패해 id 없이 온 알림은 목록에도 없다.
    const onNotify = (e: NotifyEvent) => e.id && setUnread((n) => n + 1)
    // 끊겼다 다시 붙으면 그 사이 쌓인 알림 수를 서버 기준으로 맞춘다.
    const onReconnect = () => void refresh()
    socket.on('notify', onNotify)
    socket.io.on('reconnect', onReconnect)
    return () => {
      socket.off('notify', onNotify)
      socket.io.off('reconnect', onReconnect)
    }
  }, [socket, userId, refresh])

  const value = useMemo(() => ({ unread, setUnread, refresh }), [unread, refresh])
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>
}

export function useUnread() {
  const ctx = useContext(UnreadContext)
  if (!ctx) throw new Error('useUnread must be used within UnreadProvider')
  return ctx
}
