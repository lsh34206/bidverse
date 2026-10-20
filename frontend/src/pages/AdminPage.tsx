import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { PageHead } from '../components/Ui.tsx'
import { ORDER_STATUS_LABEL, STATUS_LABEL, won } from '../types.ts'
import type { OrderStatus } from '../types.ts'
import type { AdminReport, AdminStats, AdminUser, Auction, AuditEntry, Paged } from '../types.ts'

type Tab = 'reports' | 'auctions' | 'orders' | 'users' | 'audit'
const TABS: { key: Tab; label: string }[] = [
  { key: 'reports', label: '신고' },
  { key: 'auctions', label: '경매' },
  { key: 'orders', label: '주문/환불' },
  { key: 'users', label: '사용자' },
  { key: 'audit', label: '감사 로그' },
]

const fmt = (iso: string) => new Date(iso).toLocaleString('ko-KR')

/** 목록을 불러오고 다시 불러오는 공통 훅 */
function useList<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패')
    }
  }, [path])
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, reload, setError }
}

function Stats() {
  const { data } = useList<AdminStats>('/admin/stats')
  if (!data) return null
  const cells: [string, number][] = [
    ['회원', data.users],
    ['전체 경매', data.auctions],
    ['진행 중', data.liveAuctions],
    ['중지됨', data.suspendedAuctions],
    ['입찰', data.bids],
    ['주문', data.orders],
    ['미처리 신고', data.openReports],
  ]
  return (
    <div className="stats">
      {cells.map(([label, n]) => (
        <div key={label} className={`card stat${label === '미처리 신고' && n > 0 ? ' accent' : ''}`}>
          <span className="muted">{label}</span>
          <strong>{n.toLocaleString('ko-KR')}</strong>
        </div>
      ))}
    </div>
  )
}

function Reports() {
  const [status, setStatus] = useState<'open' | 'resolved'>('open')
  const { data, error, reload, setError } = useList<Paged<AdminReport>>(
    `/admin/reports?status=${status}&limit=50`,
  )

  async function resolve(r: AdminReport, action: 'suspend' | 'dismiss') {
    let note: string | undefined
    if (action === 'suspend') {
      const input = prompt('경매 중지 사유 (판매자에게 전달됩니다)', r.reason)
      if (input === null) return
      note = input.trim() || undefined
    }
    try {
      await api(`/admin/reports/${r.id}/resolve`, { method: 'POST', json: { action, note } })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리 실패')
    }
  }

  return (
    <>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'resolved')}>
          <option value="open">미처리</option>
          <option value="resolved">처리 완료</option>
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {data?.items.length === 0 && <p className="muted">신고가 없습니다.</p>}
      <div className="rows">
        {data?.items.map((r) => (
          <div key={r.id} className="card row-item">
            <div>
              <Link to={`/auctions/${r.auction.id}`}>{r.auction.title}</Link>{' '}
              {r.auction.suspended && <span className="badge suspended">중지됨</span>}
              <p>{r.reason}</p>
              <p className="muted">
                신고자 {r.reporter.nickname ?? '-'} · {fmt(r.createdAt)}
                {r.resolution && ` · ${r.resolution === 'suspended' ? '경매 중지' : '기각'}`}
                {r.note && ` · ${r.note}`}
              </p>
            </div>
            {r.status === 'open' && (
              <div className="row-actions">
                <button className="danger" onClick={() => resolve(r, 'suspend')}>
                  경매 중지
                </button>
                <button className="secondary inline" onClick={() => resolve(r, 'dismiss')}>
                  기각
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function Auctions() {
  const [onlySuspended, setOnlySuspended] = useState(false)
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const params = new URLSearchParams({ limit: '30', sort: 'newest' })
  if (onlySuspended) params.set('suspended', 'true')
  if (query) params.set('q', query)
  const { data, error, reload, setError } = useList<Paged<Auction>>(`/admin/auctions?${params}`)

  async function act(a: Auction, action: 'suspend' | 'restore') {
    let json: unknown
    if (action === 'suspend') {
      const reason = prompt('중지 사유 (판매자에게 전달됩니다)')?.trim()
      if (!reason) return
      json = { reason }
    }
    try {
      await api(`/admin/auctions/${a.id}/${action}`, { method: 'POST', json })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리 실패')
    }
  }

  return (
    <>
      <form
        className="filters"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          setQuery(q.trim())
        }}
      >
        <input placeholder="제목 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input
            type="checkbox"
            checked={onlySuspended}
            onChange={(e) => setOnlySuspended(e.target.checked)}
          />
          중지된 경매만
        </label>
      </form>
      {error && <p className="error">{error}</p>}
      <div className="rows">
        {data?.items.map((a) => (
          <div key={a.id} className="card row-item">
            <div>
              <Link to={`/auctions/${a.id}`}>{a.title}</Link>{' '}
              <span className={`badge ${a.suspended ? 'suspended' : a.status}`}>
                {a.suspended ? '중지됨' : STATUS_LABEL[a.status]}
              </span>
              <p className="muted">
                판매자 {a.seller.nickname ?? '-'} · {won(a.currentPrice)} · 입찰 {a.bidCount}회 · 마감{' '}
                {fmt(a.endsAt)}
              </p>
              {a.suspended && a.suspendedReason && <p className="error">사유: {a.suspendedReason}</p>}
            </div>
            <div className="row-actions">
              {a.suspended ? (
                <button onClick={() => act(a, 'restore')}>복구</button>
              ) : (
                <button className="danger" onClick={() => act(a, 'suspend')}>
                  중지
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

interface AdminOrder {
  id: string
  auctionId: string
  title: string
  finalPrice: number
  status: OrderStatus
  buyer: string | null
  seller: string | null
  createdAt: string
}

function Orders() {
  const [status, setStatus] = useState<OrderStatus | ''>('paid')
  const { data, error, reload, setError } = useList<Paged<AdminOrder>>(
    `/admin/orders?limit=50${status ? `&status=${status}` : ''}`,
  )

  async function refund(o: AdminOrder) {
    const reason = prompt(`「${o.title}」 ${won(o.finalPrice)} 전액 환불 사유 (구매자·판매자에게 전달됩니다)`)?.trim()
    if (!reason) return
    try {
      await api(`/admin/orders/${o.id}/refund`, { method: 'POST', json: { reason } })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '환불 실패')
    }
  }

  return (
    <>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus | '')}>
          <option value="">전체</option>
          {(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((s) => (
            <option key={s} value={s}>
              {ORDER_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {data?.items.length === 0 && <p className="muted">주문이 없습니다.</p>}
      <div className="rows">
        {data?.items.map((o) => (
          <div key={o.id} className="card row-item">
            <div>
              <Link to={`/auctions/${o.auctionId}`}>{o.title}</Link>{' '}
              <span className={`badge order-${o.status}`}>{ORDER_STATUS_LABEL[o.status]}</span>
              <p className="muted">
                {won(o.finalPrice)} · 구매자 {o.buyer ?? '-'} · 판매자 {o.seller ?? '-'} · {fmt(o.createdAt)}
              </p>
            </div>
            {['paid', 'shipped', 'done'].includes(o.status) && (
              <div className="row-actions">
                <button className="danger" onClick={() => refund(o)}>
                  전액 환불
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function Users({ selfId }: { selfId: string }) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const { data, error, reload, setError } = useList<Paged<AdminUser>>(
    `/admin/users?limit=30${query ? `&q=${encodeURIComponent(query)}` : ''}`,
  )

  async function patch(u: AdminUser, body: Record<string, string>) {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', json: body })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리 실패')
    }
  }

  function toggleBan(u: AdminUser) {
    if (u.status === 'banned') return void patch(u, { status: 'active' })
    const reason = prompt(`${u.nickname} 계정을 정지합니다. 사유를 입력하세요.`)
    if (reason === null) return
    void patch(u, { status: 'banned', reason: reason.trim() })
  }

  return (
    <>
      <form
        className="filters"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          setQuery(q.trim())
        }}
      >
        <input placeholder="이메일 / 닉네임" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      {error && <p className="error">{error}</p>}
      <div className="rows">
        {data?.items.map((u) => (
          <div key={u.id} className="card row-item">
            <div>
              <strong>{u.nickname}</strong> <span className="muted">{u.email}</span>{' '}
              {u.status === 'banned' && <span className="badge suspended">정지</span>}
              <p className="muted">
                가입 {fmt(u.createdAt)}
                {u.bannedReason && ` · 정지 사유: ${u.bannedReason}`}
              </p>
            </div>
            <div className="row-actions">
              {u.id === selfId ? (
                <span className="muted">본인</span>
              ) : (
                <>
                  <select value={u.role} onChange={(e) => patch(u, { role: e.target.value })}>
                    <option value="buyer">buyer</option>
                    <option value="seller">seller</option>
                    <option value="admin">admin</option>
                  </select>
                  <button
                    className={u.status === 'banned' ? '' : 'danger'}
                    onClick={() => toggleBan(u)}
                  >
                    {u.status === 'banned' ? '정지 해제' : '정지'}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function Audit() {
  const { data, error } = useList<AuditEntry[]>('/admin/audit')
  return (
    <>
      {error && <p className="error">{error}</p>}
      <table className="audit">
        <thead>
          <tr>
            <th>시각</th>
            <th>관리자</th>
            <th>조치</th>
            <th>대상</th>
            <th>상세</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((a) => (
            <tr key={a.id}>
              <td>{fmt(a.createdAt)}</td>
              <td>{a.admin}</td>
              <td>{a.action}</td>
              <td className="muted">
                {a.targetType}:{a.targetId.slice(-6)}
              </td>
              <td className="muted">{a.detail ? JSON.stringify(a.detail) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <p className="muted">기록이 없습니다.</p>}
    </>
  )
}

export default function AdminPage({ selfId }: { selfId: string }) {
  const [tab, setTab] = useState<Tab>('reports')
  return (
    <>
      <PageHead title="관리자" sub="경매 · 신고 · 주문 · 사용자를 한곳에서 관리해요." />
      <Stats />
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'reports' && <Reports />}
      {tab === 'auctions' && <Auctions />}
      {tab === 'orders' && <Orders />}
      {tab === 'users' && <Users selfId={selfId} />}
      {tab === 'audit' && <Audit />}
    </>
  )
}
