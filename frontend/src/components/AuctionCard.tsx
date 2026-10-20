import { useState } from 'react'
import { Link } from 'react-router-dom'
import { isUrgent, remaining } from '../time.ts'
import type { Auction } from '../types.ts'
import { Icon } from './Icon.tsx'

export function Price({ value, className = 'price num' }: { value: number; className?: string }) {
  return (
    <span className={className}>
      {value.toLocaleString('ko-KR')}
      <small>원</small>
    </span>
  )
}

/** 상태에 따라 이미지 위에 올리는 라벨 */
function StatusChip({ auction, live }: { auction: Auction; live: boolean }) {
  if (auction.suspended) return <span className="chip chip-suspended">중지됨</span>
  if (live) {
    return (
      <span className="chip chip-live">
        <span className="dot" />
        LIVE
      </span>
    )
  }
  if (auction.status === 'scheduled') return <span className="chip chip-soon">오픈 예정</span>
  return <span className="chip">종료</span>
}

/**
 * @param now 부모가 한 번만 갱신하는 현재 시각. 카드마다 타이머를 만들지 않으려고 내려받는다.
 */
export default function AuctionCard({ auction, now = Date.now() }: { auction: Auction; now?: number }) {
  const [broken, setBroken] = useState(false)
  const image = auction.images[0]
  const endsIn = new Date(auction.endsAt).getTime() - now
  const startsIn = new Date(auction.startsAt).getTime() - now
  const status = startsIn > 0 ? 'scheduled' : endsIn > 0 ? 'live' : 'ended'
  const live = status === 'live' && !auction.suspended

  return (
    <Link to={`/auctions/${auction.id}`} className="card auction-card">
      <div className="thumb">
        {image && !broken ? (
          <img src={image} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <div className="thumb-placeholder">
            <Icon name="gavel" size={44} />
          </div>
        )}
        <StatusChip auction={{ ...auction, status }} live={live} />
        {live && (
          <span className={`time-chip${isUrgent(endsIn) ? ' urgent' : ''}`}>
            <Icon name="clock" size={13} />
            {remaining(endsIn)} 남음
          </span>
        )}
      </div>
      <div className="card-body">
        <span className="card-cat">{auction.category === 'etc' ? '기타' : auction.category}</span>
        <h3 className="card-title">{auction.title}</h3>
        <div className="card-foot">
          <div>
            <span className="price-label">{auction.bidCount > 0 ? '현재가' : '시작가'}</span>
            <Price value={auction.currentPrice} />
          </div>
          <span className="bid-count">
            <Icon name="trending" size={14} />
            입찰 {auction.bidCount}
          </span>
        </div>
      </div>
    </Link>
  )
}
