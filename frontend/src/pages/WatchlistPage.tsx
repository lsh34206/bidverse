import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import AuctionCard from '../components/AuctionCard.tsx'
import { Alert, CardSkeletons, EmptyState, PageHead } from '../components/Ui.tsx'
import { useNow } from '../time.ts'
import type { Auction } from '../types.ts'

export default function WatchlistPage() {
  const [items, setItems] = useState<Auction[] | null>(null)
  const [error, setError] = useState('')
  const now = useNow(30_000)

  useEffect(() => {
    api<Auction[]>('/me/watchlist')
      .then(setItems)
      .catch((e: Error) => setError(e.message))
  }, [])

  return (
    <>
      <PageHead title="관심 경매" sub="마감 1시간 전에 알림을 보내 드려요." />
      {error && <Alert>{error}</Alert>}
      {!items && !error && <CardSkeletons count={4} />}
      {items?.length === 0 && (
        <div className="card">
          <EmptyState icon="heart" title="담아 둔 경매가 없어요">
            경매 상세에서 <b>관심 등록</b>을 누르면 여기에 모여요.
            <div style={{ marginTop: 14 }}>
              <Link className="button inline" to="/">
                경매 둘러보기
              </Link>
            </div>
          </EmptyState>
        </div>
      )}
      <div className="grid">
        {items?.map((a) => <AuctionCard key={a.id} auction={a} now={now} />)}
      </div>
    </>
  )
}
