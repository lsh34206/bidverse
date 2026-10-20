import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { Alert, EmptyState, PageHead } from '../components/Ui.tsx'
import { NOTIF_ICON, notificationLink } from '../Notifications.tsx'
import { describeNotification } from '../types.ts'
import type { NotificationItem, NotificationPage } from '../types.ts'
import { useUnread } from '../unread.tsx'

const LIMIT = 20

export default function NotificationsPage() {
  const { setUnread } = useUnread()
  const [page, setPage] = useState(1)
  const [data, setData] = useState<NotificationPage | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const d = await api<NotificationPage>(`/me/notifications?page=${page}&limit=${LIMIT}`)
      setData(d)
      setUnread(d.unreadCount)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패')
    }
  }, [page, setUnread])

  useEffect(() => {
    void load()
  }, [load])

  async function markRead(ids?: string[]) {
    try {
      await api('/me/notifications/read', { method: 'POST', json: ids ? { ids } : {} })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리 실패')
    }
  }

  const open = (n: NotificationItem) => {
    if (!n.read) void markRead([n.id])
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  return (
    <div className="form-narrow">
      <PageHead title="알림" sub="입찰, 낙찰, 결제 소식을 한곳에서 확인해요.">
        {data && data.unreadCount > 0 && (
          <button className="secondary inline" onClick={() => markRead()}>
            <Icon name="check" size={15} />
            모두 읽음 ({data.unreadCount})
          </button>
        )}
      </PageHead>

      {error && <Alert>{error}</Alert>}
      {!data && !error && (
        <div className="notif-list" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 82, borderRadius: 14 }} />
          ))}
        </div>
      )}
      {data?.items.length === 0 && (
        <div className="card">
          <EmptyState icon="bell" title="새로운 알림이 없어요">
            입찰이 들어오거나 낙찰되면 여기에 알려 드려요.
          </EmptyState>
        </div>
      )}
      <ul className="notif-list">
        {data?.items.map((n) => {
          const view = describeNotification(n)
          return (
            <li key={n.id} className={`card notif tone-${view.tone} ${n.read ? 'read' : 'unread'}`}>
              <Link to={notificationLink(n)} onClick={() => open(n)}>
                <span className="tone-icon">
                  <Icon name={NOTIF_ICON[n.type]} size={18} />
                </span>
                <span className="n-body">
                  <strong>{view.heading}</strong>
                  <span>{view.text}</span>
                  <span className="muted">{new Date(n.createdAt).toLocaleString('ko-KR')}</span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>

      {data && pages > 1 && (
        <nav className="pager" aria-label="페이지 이동">
          <button className="secondary inline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            이전
          </button>
          <span className="num">
            {page} / {pages}
          </span>
          <button className="secondary inline" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            다음
          </button>
        </nav>
      )}
    </div>
  )
}
