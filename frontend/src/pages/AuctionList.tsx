import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api.ts'
import AuctionCard from '../components/AuctionCard.tsx'
import { Icon } from '../components/Icon.tsx'
import { Alert, CardSkeletons, EmptyState } from '../components/Ui.tsx'
import { useNow } from '../time.ts'
import { CATEGORIES } from '../types.ts'
import type { AuctionPage } from '../types.ts'

const LIMIT = 12

// 기본 탭은 '진행 중'. (전체에서 마감 임박순으로 정렬하면 이미 끝난 경매가 맨 위에 와서 쓸모가 없다)
const STATUS_TABS = [
  { value: 'live', label: '진행 중' },
  { value: 'scheduled', label: '예정' },
  { value: 'ended', label: '종료' },
  { value: 'all', label: '전체' },
] as const

const categoryLabel = (c: string) => (c === 'etc' ? '기타' : c)

export default function AuctionList() {
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<AuctionPage | null>(null)
  const [liveCount, setLiveCount] = useState<number | null>(null)
  const [error, setError] = useState('')
  const now = useNow(30_000)

  const q = params.get('q') ?? ''
  const category = params.get('category') ?? ''
  const status = params.get('status') ?? 'live'
  // 종료된 경매는 '가장 먼저 끝난 순'이 아니라 최근 것부터 보여준다.
  const sort = params.get('sort') ?? (status === 'ended' || status === 'all' ? 'newest' : 'endingSoon')
  const page = Number(params.get('page') ?? '1')
  const [search, setSearch] = useState(q)

  useEffect(() => setSearch(q), [q])

  useEffect(() => {
    const query = new URLSearchParams({ sort, page: String(page), limit: String(LIMIT) })
    if (q) query.set('q', q)
    if (category) query.set('category', category)
    if (status !== 'all') query.set('status', status)
    let cancelled = false
    setData(null)
    api<AuctionPage>(`/auctions?${query}`)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError('')
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [q, category, status, sort, page])

  // 히어로에 보여줄 "지금 진행 중" 수
  useEffect(() => {
    api<AuctionPage>('/auctions?status=live&limit=1')
      .then((d) => setLiveCount(d.total))
      .catch(() => undefined)
  }, [])

  function set(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'page') next.delete('page')
    setParams(next)
  }

  function onSearch(e: FormEvent) {
    e.preventDefault()
    set('q', search.trim())
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1
  const filtered = !!(q || category || status !== 'live')

  return (
    <>
      <section className="hero">
        <span className="live-pill">
          <span className="dot" />
          {liveCount === null ? '실시간 경매 진행 중' : `지금 ${liveCount.toLocaleString('ko-KR')}개의 경매가 진행 중`}
        </span>
        <h1>
          실시간으로 경쟁하고, <em>가장 좋은 가격</em>에 낙찰받으세요
        </h1>
        <p>입찰이 들어오는 순간 모든 화면이 바로 바뀌어요. 마감 직전 입찰은 자동으로 시간이 연장돼 끝까지 공정해요.</p>
        <form className="hero-search" onSubmit={onSearch} role="search">
          <label className="field">
            <span className="sr-only">경매 검색</span>
            <Icon name="search" />
            <input
              placeholder="찾고 싶은 물건을 검색해 보세요"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <button type="submit">검색</button>
        </form>
      </section>

      <div className="toolbar">
        <div className="pills" role="group" aria-label="카테고리">
          <button className={`pill${category === '' ? ' active' : ''}`} onClick={() => set('category', '')}>
            전체
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              className={`pill${category === c ? ' active' : ''}`}
              onClick={() => set('category', category === c ? '' : c)}
            >
              {categoryLabel(c)}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <div className="segmented" role="group" aria-label="경매 상태">
            {STATUS_TABS.map((t) => (
              <button
                key={t.value}
                className={status === t.value ? 'active' : ''}
                onClick={() => set('status', t.value === 'live' ? '' : t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <select value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="정렬">
            <option value="endingSoon">마감 임박순</option>
            <option value="newest">최신 등록순</option>
            <option value="priceAsc">낮은 가격순</option>
            <option value="priceDesc">높은 가격순</option>
          </select>
        </div>
      </div>

      {q && (
        <p className="result-count" style={{ marginBottom: 14 }}>
          「{q}」 검색 결과 {data ? `${data.total.toLocaleString('ko-KR')}건` : ''}{' '}
          <button className="link" onClick={() => set('q', '')}>
            검색 지우기
          </button>
        </p>
      )}

      {error && <Alert>{error}</Alert>}
      {!data && !error && <CardSkeletons count={8} />}
      {data && data.items.length === 0 && (
        <EmptyState icon="search" title={filtered ? '조건에 맞는 경매가 없어요' : '아직 등록된 경매가 없어요'}>
          {filtered ? (
            <button
              className="secondary inline"
              onClick={() => setParams(new URLSearchParams())}
              style={{ marginTop: 6 }}
            >
              필터 초기화
            </button>
          ) : (
            '첫 경매를 등록해 보세요.'
          )}
        </EmptyState>
      )}
      <div className="grid">
        {data?.items.map((a) => <AuctionCard key={a.id} auction={a} now={now} />)}
      </div>

      {data && pages > 1 && (
        <nav className="pager" aria-label="페이지 이동">
          <button className="secondary inline" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>
            <Icon name="arrowLeft" size={15} />
            이전
          </button>
          <span className="num">
            {page} / {pages}
          </span>
          <button className="secondary inline" disabled={page >= pages} onClick={() => set('page', String(page + 1))}>
            다음
            <Icon name="arrowRight" size={15} />
          </button>
        </nav>
      )}
    </>
  )
}
