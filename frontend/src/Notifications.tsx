import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './components/Icon.tsx'
import type { IconName } from './components/Icon.tsx'
import { describeNotification } from './types.ts'
import type { NotifyEvent, NotifyType } from './types.ts'
import { useSocket } from './socket.tsx'

interface Toast extends NotifyEvent {
  key: number
}

/** 알림 종류별 아이콘 (토스트와 알림 센터가 같이 쓴다) */
export const NOTIF_ICON: Record<NotifyType, IconName> = {
  outbid: 'trending',
  won: 'check',
  sold: 'check',
  unsold: 'box',
  ending: 'clock',
  suspended: 'alert',
  restored: 'check',
  paid: 'card',
  refunded: 'undo',
}

/** 알림 센터로 가야 하는 종류는 주문 페이지, 나머지는 해당 경매로 보낸다. */
export const notificationLink = (n: { type: NotifyEvent['type']; auctionId: string }) =>
  ['won', 'sold', 'paid', 'refunded'].includes(n.type) ? '/orders' : `/auctions/${n.auctionId}`

/** 실시간으로 도착한 알림을 잠깐 띄우는 토스트 */
export default function Notifications() {
  const socket = useSocket()
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    if (!socket) return
    let seq = 0
    const onNotify = (event: NotifyEvent) => {
      const key = ++seq
      setToasts((t) => [...t, { ...event, key }])
      setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), 8000)
    }
    socket.on('notify', onNotify)
    return () => {
      socket.off('notify', onNotify)
    }
  }, [socket])

  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const view = describeNotification(t)
        return (
          <Link key={t.key} to={notificationLink(t)} className={`card toast tone-${view.tone}`}>
            <span className="tone-icon">
              <Icon name={NOTIF_ICON[t.type]} size={18} />
            </span>
            <span className="t-body">
              <strong>{view.heading}</strong>
              <span>{view.text}</span>
            </span>
          </Link>
        )
      })}
    </div>
  )
}
