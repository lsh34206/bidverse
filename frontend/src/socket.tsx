import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { tokenStore } from './api.ts'
import { useAuth } from './auth.tsx'

const SocketContext = createContext<Socket | null>(null)

/** 로그인 사용자가 바뀌면 소켓을 새로 연결해서 개인 알림 룸이 올바른 사용자로 잡히게 한다. */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id
  const [socket, setSocket] = useState<Socket | null>(null)

  useEffect(() => {
    // 재연결 때마다 최신 토큰을 읽도록 콜백 형태로 넘긴다.
    // websocket 전용: 기본값인 HTTP long-polling은 요청마다 다른 서버 인스턴스로 갈 수 있어서
    // 서버를 여러 대 띄우면(Redis 구성) sticky session 없이는 연결이 끊긴다.
    const s = io({
      transports: ['websocket'],
      auth: (cb) => cb({ token: tokenStore.get() }),
    })
    setSocket(s)
    return () => {
      s.disconnect()
    }
  }, [userId])

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>
}

export function useSocket() {
  return useContext(SocketContext)
}
