import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { Price } from '../components/AuctionCard.tsx'
import { Icon } from '../components/Icon.tsx'
import { Alert, EmptyState, PageHead } from '../components/Ui.tsx'
import { fmtDateTime } from '../time.ts'
import { ORDER_STATUS_LABEL } from '../types.ts'
import type { Order, OrderStatus } from '../types.ts'

type Step = 'ship' | 'confirm'

/** 역할·상태에 따라 지금 사용자가 누를 수 있는 다음 단계 (결제는 별도 결제 화면으로 이동) */
function nextStep(order: Order): { step: Step; label: string; icon: 'truck' | 'check' } | null {
  if (order.role === 'seller' && order.status === 'paid') return { step: 'ship', label: '발송 처리', icon: 'truck' }
  if (order.role === 'buyer' && order.status === 'shipped') return { step: 'confirm', label: '수령 확인', icon: 'check' }
  return null
}

function waitingFor(order: Order): string | null {
  if (order.role === 'seller' && order.status === 'pending') return '구매자의 결제를 기다리고 있어요'
  if (order.role === 'buyer' && order.status === 'paid') return '판매자가 발송을 준비하고 있어요'
  if (order.role === 'seller' && order.status === 'shipped') return '구매자의 수령 확인을 기다리고 있어요'
  return null
}

const STEPS: { label: string; done: OrderStatus[]; current: OrderStatus }[] = [
  { label: '결제', done: ['paid', 'shipped', 'done'], current: 'pending' },
  { label: '발송', done: ['shipped', 'done'], current: 'paid' },
  { label: '수령 확인', done: ['done'], current: 'shipped' },
]

/** 결제 → 발송 → 수령 확인 진행 상황 */
function Stepper({ status }: { status: OrderStatus }) {
  return (
    <ol className="stepper" aria-label="주문 진행 상황" style={{ listStyle: 'none', margin: 0, paddingInline: 0 }}>
      {STEPS.map((s, i) => {
        const done = s.done.includes(status)
        const current = status === s.current
        return (
          <li key={s.label} className={`step${done ? ' done' : ''}${current ? ' current' : ''}`}>
            <span className="bullet">{done ? <Icon name="check" size={14} /> : i + 1}</span>
            {s.label}
          </li>
        )
      })}
    </ol>
  )
}

export default function Orders() {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setOrders(await api<Order[]>('/me/orders'))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '불러오기 실패')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function run(order: Order, request: () => Promise<unknown>) {
    setBusyId(order.id)
    setError('')
    try {
      await request()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리 실패')
      void load() // 다른 쪽에서 이미 상태가 바뀌었을 수 있다.
    } finally {
      setBusyId(null)
    }
  }

  const advance = (order: Order, step: Step) => run(order, () => api(`/orders/${order.id}/${step}`, { method: 'POST' }))

  function cancelPayment(order: Order) {
    const reason = prompt('결제를 취소(환불)하는 이유를 입력해 주세요')?.trim()
    if (!reason) return
    void run(order, () => api(`/orders/${order.id}/refund`, { method: 'POST', json: { reason } }))
  }

  return (
    <div className="form-narrow" style={{ maxWidth: 880 }}>
      <PageHead title="내 주문" sub="낙찰·즉시구매로 생긴 주문이에요. 결제는 토스페이먼츠로 안전하게 진행돼요." />
      {error && <Alert>{error}</Alert>}
      {!orders && !error && (
        <div className="orders" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton" style={{ height: 190, borderRadius: 14 }} />
          ))}
        </div>
      )}
      {orders?.length === 0 && (
        <div className="card">
          <EmptyState icon="receipt" title="아직 주문이 없어요">
            경매에서 낙찰받거나 즉시구매하면 여기에 나타나요.
            <div style={{ marginTop: 14 }}>
              <Link className="button inline" to="/">
                경매 둘러보기
              </Link>
            </div>
          </EmptyState>
        </div>
      )}
      <div className="orders">
        {orders?.map((o) => {
          const next = nextStep(o)
          const waiting = waitingFor(o)
          return (
            <div key={o.id} className="card order">
              <div>
                <div className="inline-actions">
                  <span className={`badge order-${o.status}`}>{ORDER_STATUS_LABEL[o.status]}</span>
                  <span className="badge">{o.role === 'buyer' ? '구매' : '판매'}</span>
                </div>
                <h3>
                  <Link to={`/auctions/${o.auctionId}`}>{o.title}</Link>
                </h3>
                <Price value={o.finalPrice} />
                <p className="muted" style={{ marginTop: 4 }}>
                  {o.role === 'buyer' ? `판매자 ${o.seller.nickname ?? '-'}` : `구매자 ${o.buyer.nickname ?? '-'}`} ·{' '}
                  {fmtDateTime(o.createdAt)}
                </p>
              </div>

              <div className="order-actions">
                {o.role === 'buyer' && o.status === 'pending' && (
                  <Link className="button" to={`/orders/${o.id}/pay`}>
                    <Icon name="card" size={16} />
                    결제하기
                  </Link>
                )}
                {next && (
                  <button disabled={busyId === o.id} onClick={() => advance(o, next.step)}>
                    <Icon name={next.icon} size={16} />
                    {next.label}
                  </button>
                )}
                {o.role === 'buyer' && o.status === 'paid' && (
                  <button className="secondary inline" disabled={busyId === o.id} onClick={() => cancelPayment(o)}>
                    결제 취소(환불)
                  </button>
                )}
                {waiting && <span className="muted">{waiting}</span>}
                {o.status === 'refunded' && o.refundedAt && (
                  <span className="muted">{fmtDateTime(o.refundedAt)} 환불됨</span>
                )}
              </div>

              {o.status !== 'refunded' && <Stepper status={o.status} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
