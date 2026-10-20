import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.ts'
import { useAuth } from '../auth.tsx'
import { Price } from '../components/AuctionCard.tsx'
import AuctionChat from '../components/AuctionChat.tsx'
import { Icon } from '../components/Icon.tsx'
import { Alert, EmptyState } from '../components/Ui.tsx'
import { useSocket } from '../socket.tsx'
import { clock, fmtDateTime, initial, isUrgent } from '../time.ts'
import { STATUS_LABEL, won } from '../types.ts'
import type { Auction, AuctionStatus, Bid, BidEvent, BidUpdate, EndedEvent } from '../types.ts'

const BID_HISTORY_LIMIT = 30

export default function AuctionDetail() {
  const { id } = useParams()
  const { user } = useAuth()
  const socket = useSocket()
  const navigate = useNavigate()

  const [auction, setAuction] = useState<Auction | null>(null)
  const [bids, setBids] = useState<Bid[]>([])
  const [error, setError] = useState('')
  const [clockOffset, setClockOffset] = useState(0) // 서버 시각 - 내 시각
  const [now, setNow] = useState(() => Date.now())
  const [amount, setAmount] = useState('')
  const [bidError, setBidError] = useState('')
  const [bidding, setBidding] = useState(false)
  const [notice, setNotice] = useState('')
  const [ended, setEnded] = useState<EndedEvent | null>(null)
  const [watching, setWatching] = useState(false)
  const [info, setInfo] = useState('')
  const [selected, setSelected] = useState(0)
  const [viewers, setViewers] = useState<number | undefined>()
  const [imgBroken, setImgBroken] = useState<Record<string, boolean>>({})
  const userId = user?.id

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api<Auction>(`/auctions/${id}`),
        api<Bid[]>(`/auctions/${id}/bids?limit=${BID_HISTORY_LIMIT}`),
      ])
      setAuction(a)
      setBids(b)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패')
    }
  }, [id])

  // 입찰 성공 응답과 소켓 이벤트가 같은 경로로 들어오므로, 오래된 갱신이 최신 값을 덮지 않게 입찰 수로 걸러낸다.
  const applyUpdate = useCallback((u: BidUpdate) => {
    setAuction((a) =>
      a && u.bidCount >= a.bidCount
        ? {
            ...a,
            currentPrice: u.currentPrice,
            bidCount: u.bidCount,
            minNextBid: u.minNextBid,
            highestBidderId: u.highestBidderId,
            endsAt: u.endsAt,
          }
        : a,
    )
    setBids((prev) =>
      u.bid.id && prev.some((b) => b.id === u.bid.id)
        ? prev
        : [u.bid, ...prev].slice(0, BID_HISTORY_LIMIT),
    )
    if (u.extended) setNotice('마감 직전 입찰로 마감 시간이 5분 연장되었어요.')
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!socket || !id) return
    const join = () =>
      socket.emit(
        'auction:join',
        { auctionId: id },
        (ack?: { ok: boolean; serverTime?: number; viewers?: number }) => {
          if (ack?.ok && ack.serverTime) setClockOffset(ack.serverTime - Date.now())
          if (ack?.viewers) setViewers(ack.viewers)
        },
      )
    const onBid = (e: BidEvent) => {
      if (e.auctionId === id) applyUpdate(e)
    }
    const onEnded = (e: EndedEvent) => {
      if (e.auctionId !== id) return
      setEnded(e)
      void load() // 정산 결과(result)를 반영한다.
    }
    const onViewers = (e: { auctionId: string; count: number }) => {
      if (e.auctionId === id) setViewers(e.count)
    }
    // 연결이 끊겼다 돌아오면 그 사이 놓친 입찰을 다시 받아온다.
    const onReconnect = () => void load()

    socket.on('connect', join)
    socket.on('auction:viewers', onViewers)
    socket.on('bid:new', onBid)
    socket.on('auction:ended', onEnded)
    socket.io.on('reconnect', onReconnect)
    if (socket.connected) join()
    return () => {
      socket.off('connect', join)
      socket.off('auction:viewers', onViewers)
      socket.off('bid:new', onBid)
      socket.off('auction:ended', onEnded)
      socket.io.off('reconnect', onReconnect)
      socket.emit('auction:leave', { auctionId: id })
    }
  }, [socket, id, applyUpdate, load])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 입력값이 최소 입찰가 아래로 떨어지면 최소 입찰가로 끌어올린다.
  const minNextBid = auction?.minNextBid
  useEffect(() => {
    if (minNextBid === undefined) return
    setAmount((prev) => (!prev || Number(prev) < minNextBid ? String(minNextBid) : prev))
  }, [minNextBid])

  async function onBid(e: FormEvent) {
    e.preventDefault()
    setBidding(true)
    setBidError('')
    try {
      applyUpdate(
        await api<BidUpdate>(`/auctions/${id}/bids`, {
          method: 'POST',
          json: { amount: Number(amount) },
        }),
      )
    } catch (err) {
      setBidError(err instanceof Error ? err.message : '입찰 실패')
      void load()
    } finally {
      setBidding(false)
    }
  }

  // 관심 목록에 담겨 있는지 확인한다 (로그인한 경우만).
  useEffect(() => {
    if (!userId || !id) {
      setWatching(false)
      return
    }
    let cancelled = false
    api<string[]>('/me/watchlist/ids')
      .then((ids) => !cancelled && setWatching(ids.includes(id)))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [userId, id])

  async function toggleWatch() {
    const next = !watching
    setWatching(next) // 낙관적으로 먼저 바꾸고, 실패하면 되돌린다.
    try {
      await api(`/watchlist/${id}`, { method: next ? 'POST' : 'DELETE' })
    } catch (e) {
      setWatching(!next)
      setInfo(e instanceof Error ? e.message : '처리 실패')
    }
  }

  async function report() {
    const reason = prompt('신고 사유를 입력해 주세요 (5자 이상)')?.trim()
    if (!reason) return
    try {
      await api(`/auctions/${id}/report`, { method: 'POST', json: { reason } })
      setInfo('신고가 접수되었어요. 검토 후 조치할게요.')
    } catch (e) {
      setInfo(e instanceof Error ? e.message : '신고 실패')
    }
  }

  async function buyNow() {
    if (!auction?.buyNowPrice) return
    if (!confirm(`${won(auction.buyNowPrice)}에 즉시 구매할까요? 경매가 바로 종료됩니다.`)) return
    setBidding(true)
    setBidError('')
    try {
      applyUpdate(await api<BidUpdate>(`/auctions/${id}/buy-now`, { method: 'POST' }))
      void load()
    } catch (err) {
      setBidError(err instanceof Error ? err.message : '즉시구매 실패')
      void load()
    } finally {
      setBidding(false)
    }
  }

  async function remove() {
    if (!confirm('이 경매를 삭제할까요?')) return
    try {
      await api(`/auctions/${id}`, { method: 'DELETE' })
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제 실패')
    }
  }

  if (error && !auction) {
    return (
      <>
        <Alert>{error}</Alert>
        <p style={{ marginTop: 16 }}>
          <Link to="/">← 경매 목록으로</Link>
        </p>
      </>
    )
  }
  if (!auction) {
    return (
      <div className="detail-grid" aria-busy="true" aria-label="불러오는 중">
        <div className="gallery">
          <div className="skeleton" style={{ aspectRatio: '4 / 3', borderRadius: 22 }} />
        </div>
        <div className="panel">
          <div className="skeleton" style={{ height: 420, borderRadius: 14 }} />
        </div>
      </div>
    )
  }

  const serverNow = now + clockOffset
  const startsAt = new Date(auction.startsAt).getTime()
  const endsAt = new Date(auction.endsAt).getTime()
  const status: AuctionStatus = serverNow < startsAt ? 'scheduled' : serverNow < endsAt ? 'live' : 'ended'

  const isOwner = user?.id === auction.seller.id
  const isLeading = !!user && auction.highestBidderId === user.id
  const canModify = (isOwner || user?.role === 'admin') && auction.bidCount === 0
  const biddable = status === 'live' && !auction.suspended
  const canBuyNow =
    biddable &&
    !!user &&
    !isOwner &&
    auction.buyNowPrice !== null &&
    auction.currentPrice < auction.buyNowPrice
  const result = auction.result ?? ended?.result ?? null
  const urgent = status === 'live' && isUrgent(endsAt - serverNow)

  const images = auction.images.filter((src) => !imgBroken[src])
  const mainImage = images[Math.min(selected, images.length - 1)]
  // 최소가에서 몇 단위 올릴지 고르는 빠른 입찰 버튼
  const quick = [0, 1, 2, 5].map((k) => ({ k, value: auction.minNextBid + k * auction.minIncrement }))

  return (
    <>
      <nav className="crumbs" aria-label="경로">
        <Link to="/">경매</Link>
        <span>/</span>
        <Link to={`/?category=${encodeURIComponent(auction.category)}`}>
          {auction.category === 'etc' ? '기타' : auction.category}
        </Link>
      </nav>

      <div className="detail-grid">
        <section className="gallery" aria-label="상품 이미지">
          <div className="gallery-main">
            {mainImage ? (
              <img
                src={mainImage}
                alt={auction.title}
                onError={() => setImgBroken((b) => ({ ...b, [mainImage]: true }))}
              />
            ) : (
              <div className="thumb-placeholder">
                <Icon name="gavel" size={72} />
              </div>
            )}
            {auction.suspended ? (
              <span className="chip chip-suspended">중지됨</span>
            ) : status === 'live' ? (
              <span className="chip chip-live">
                <span className="dot" />
                LIVE
              </span>
            ) : status === 'scheduled' ? (
              <span className="chip chip-soon">오픈 예정</span>
            ) : (
              <span className="chip">종료</span>
            )}
          </div>
          {images.length > 1 && (
            <div className="thumbs">
              {images.map((src, i) => (
                <button
                  key={src}
                  type="button"
                  className={i === selected ? 'active' : ''}
                  onClick={() => setSelected(i)}
                  aria-label={`이미지 ${i + 1}`}
                >
                  <img src={src} alt="" />
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="panel">
          <div className="panel-inner">
          <div className="card panel-card">
            <div className="inline-actions" style={{ justifyContent: 'space-between' }}>
              <span className={`badge ${auction.suspended ? 'suspended' : status}`}>
                {status === 'live' && !auction.suspended && <span className="dot" />}
                {auction.suspended ? '중지됨' : STATUS_LABEL[status]}
              </span>
              {user && !isOwner && (
                <span className="inline-actions">
                  <button
                    type="button"
                    className="secondary inline"
                    aria-pressed={watching}
                    onClick={toggleWatch}
                  >
                    <Icon
                      name="heart"
                      size={15}
                      fill={watching}
                      style={watching ? { color: 'var(--live)' } : undefined}
                    />
                    {watching ? '관심 해제' : '관심 등록'}
                  </button>
                  <button type="button" className="link" onClick={report} title="신고하기" aria-label="신고하기">
                    <Icon name="flag" size={16} />
                  </button>
                </span>
              )}
            </div>

            <h1>{auction.title}</h1>
            <div className="meta-line">
              <span>
                <span className="avatar sm">{initial(auction.seller.nickname)}</span>
                {auction.seller.nickname ?? '알 수 없음'}
              </span>
              <span>
                <Icon name="trending" size={15} />
                입찰 {auction.bidCount}회
              </span>
            </div>

            {info && (
              <div style={{ marginTop: 14 }}>
                <Alert kind="notice">{info}</Alert>
              </div>
            )}

            <div className="price-box">
              <span className="price-label">{auction.bidCount > 0 ? '현재 최고가' : '시작가'}</span>
              <span key={auction.currentPrice} className="flash" style={{ display: 'block' }}>
                <Price value={auction.currentPrice} className="price big num" />
              </span>
              {status !== 'ended' && (
                <div className={`countdown${urgent ? ' urgent' : ''}`}>
                  <Icon name="clock" size={20} className="clock" />
                  <span>{status === 'live' ? '남은 시간' : '시작까지'}</span>
                  <strong>{clock(status === 'live' ? endsAt - serverNow : startsAt - serverNow)}</strong>
                </div>
              )}
            </div>

            {notice && status === 'live' && (
              <div style={{ marginTop: 14 }}>
                <Alert kind="notice">{notice}</Alert>
              </div>
            )}

            {status === 'ended' && (
              <div className="ended-banner">
                {result === 'unsold' || auction.bidCount === 0 ? (
                  <strong>입찰 없이 종료된 경매예요</strong>
                ) : (
                  <>
                    <strong>경매가 종료되었어요</strong>
                    <span className="muted">
                      낙찰자 {bids[0]?.bidder ?? ended?.winner ?? '-'} · 낙찰가 {won(auction.currentPrice)}
                    </span>
                    {isLeading && (
                      <span>
                        🎉 낙찰을 축하해요! <Link to="/orders">내 주문</Link>에서 결제를 진행해 주세요.
                      </span>
                    )}
                    {isOwner && (
                      <span>
                        <Link to="/orders">내 주문</Link>에서 거래를 진행해 주세요.
                      </span>
                    )}
                  </>
                )}
              </div>
            )}

            {auction.suspended && (
              <div className="ended-banner">
                <strong>관리자에 의해 중지된 경매예요</strong>
                <span className="muted">입찰과 즉시구매가 막혀 있고, 중지가 풀리기 전까지 정산되지 않아요.</span>
              </div>
            )}

            {biddable && (
              <form className="bid-form" onSubmit={onBid}>
                {isOwner ? (
                  <p className="muted">내가 등록한 경매에는 입찰할 수 없어요.</p>
                ) : !user ? (
                  <Link
                    className="button btn-lg btn-block"
                    to="/login"
                    state={{ from: `/auctions/${auction.id}` }}
                  >
                    로그인하고 입찰하기
                  </Link>
                ) : (
                  <>
                    {isLeading && (
                      <div className="leading">
                        <Icon name="check" size={18} />
                        현재 내가 최고가 입찰자예요
                      </div>
                    )}
                    <div className="bid-row">
                      <label className="field">
                        <span className="sr-only">입찰 금액</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          value={amount}
                          min={auction.minNextBid}
                          step={1}
                          onChange={(e) => setAmount(e.target.value)}
                          disabled={isLeading}
                          required
                        />
                        <span>원</span>
                      </label>
                      <button disabled={bidding || isLeading}>입찰하기</button>
                    </div>
                    {!isLeading && (
                      <div className="quick-bids" role="group" aria-label="빠른 입찰 금액">
                        {quick.map(({ k, value }) => (
                          <button key={k} type="button" onClick={() => setAmount(String(value))} title={won(value)}>
                            {k === 0 ? `최소 ${auction.minNextBid.toLocaleString('ko-KR')}원` : `+${(k * auction.minIncrement).toLocaleString('ko-KR')}`}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {canBuyNow && (
                  <button type="button" className="secondary btn-block" disabled={bidding} onClick={buyNow}>
                    <Icon name="zap" size={16} />
                    {won(auction.buyNowPrice ?? 0)}에 즉시구매
                  </button>
                )}
                {bidError && <Alert>{bidError}</Alert>}
              </form>
            )}

            {error && (
              <div style={{ marginTop: 14 }}>
                <Alert>{error}</Alert>
              </div>
            )}
            {canModify && (
              <div className="actions" style={{ marginTop: 18 }}>
                <Link className="button secondary inline" to={`/auctions/${auction.id}/edit`}>
                  수정
                </Link>
                <button className="danger inline" onClick={remove}>
                  삭제
                </button>
              </div>
            )}
          </div>
          <AuctionChat
            auctionId={auction.id}
            userId={user?.id}
            loggedIn={!!user}
            canModerate={isOwner || user?.role === 'admin'}
            viewers={viewers}
            closedReason={
              auction.suspended
                ? '관리자에 의해 중지된 경매예요. 채팅은 읽기만 할 수 있어요.'
                : status === 'ended'
                  ? '종료된 경매의 채팅은 읽기만 할 수 있어요.'
                  : null
            }
          />
          </div>
        </aside>

        <section className="card about">
          <h2>상품 설명</h2>
          {auction.description ? (
            <p className="description">{auction.description}</p>
          ) : (
            <p className="muted">판매자가 등록한 설명이 없어요.</p>
          )}
          <dl
            className="info-list"
            style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--border)' }}
          >
            <dt>시작가</dt>
            <dd>{won(auction.startPrice)}</dd>
            <dt>최소 입찰 단위</dt>
            <dd>{won(auction.minIncrement)}</dd>
            {auction.buyNowPrice !== null && (
              <>
                <dt>즉시구매가</dt>
                <dd>{won(auction.buyNowPrice)}</dd>
              </>
            )}
            <dt>경매 시작</dt>
            <dd>{fmtDateTime(auction.startsAt)}</dd>
            <dt>경매 마감</dt>
            <dd>{fmtDateTime(auction.endsAt)}</dd>
          </dl>
        </section>

        <section className="card history" aria-live="polite">
          <h2>
            입찰 내역 {bids.length > 0 && <span className="muted">({auction.bidCount})</span>}
          </h2>
          {bids.length === 0 ? (
            <EmptyState icon="trending" title="아직 입찰이 없어요">
              첫 입찰의 주인공이 되어 보세요.
            </EmptyState>
          ) : (
            <ul className="bid-list">
              {bids.map((b, i) => (
                <li key={b.id || `${b.createdAt}-${i}`} className={i === 0 ? 'top' : undefined}>
                  <span className="who">
                    <span className="avatar sm">{initial(b.bidder)}</span>
                    {b.bidder}
                    {i === 0 && <span className="top-tag">최고가</span>}
                  </span>
                  <strong className="num">{won(b.amount)}</strong>
                  <span className="muted num">{new Date(b.createdAt).toLocaleTimeString('ko-KR')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
