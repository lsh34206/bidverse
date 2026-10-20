import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.ts'
import { useAuth } from '../auth.tsx'
import { Price } from '../components/AuctionCard.tsx'
import { Icon } from '../components/Icon.tsx'
import { Alert } from '../components/Ui.tsx'
import { createWidgets, isUserCancel, loadTossSdk } from '../toss.ts'
import type { TossWidgets } from '../toss.ts'
import type { PaymentConfirmResult, PaymentPrepare } from '../types.ts'

/**
 * 결제 화면.
 *  - toss: 토스 결제위젯을 붙이고, 결제 버튼을 누르면 토스 결제창으로 이동한다. 승인은 /payments/success 에서.
 *  - mock: 키가 없는 개발 환경 전용. 가짜 승인으로 결제 흐름만 확인한다.
 *  - off:  운영인데 토스 키가 설정되지 않은 상태. 결제를 막는다.
 */
export default function CheckoutPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [prep, setPrep] = useState<PaymentPrepare | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const widgets = useRef<TossWidgets | null>(null)
  const [widgetReady, setWidgetReady] = useState(false)

  // 주문번호/금액은 서버가 정한다. 화면이 보여주는 금액도 서버 응답 그대로다.
  useEffect(() => {
    let cancelled = false
    api<PaymentPrepare>(`/orders/${id}/payment`, { method: 'POST' })
      .then((p) => !cancelled && setPrep(p))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (!prep || prep.mode !== 'toss' || !prep.clientKey) return
    let cancelled = false
    ;(async () => {
      try {
        await loadTossSdk()
        const w = createWidgets(prep.clientKey!, prep.customerKey)
        await w.setAmount({ currency: 'KRW', value: prep.amount })
        await Promise.all([
          w.renderPaymentMethods({ selector: '#payment-method' }),
          w.renderAgreement({ selector: '#agreement' }),
        ])
        if (cancelled) return
        widgets.current = w
        setWidgetReady(true)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '결제창을 준비하지 못했어요')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [prep])

  async function payWithToss() {
    if (!prep || !widgets.current) return
    setBusy(true)
    setError('')
    try {
      await widgets.current.requestPayment({
        orderId: prep.orderId,
        orderName: prep.orderName,
        successUrl: `${window.location.origin}/payments/success`,
        failUrl: `${window.location.origin}/payments/fail`,
        customerName: user?.nickname,
      })
    } catch (e) {
      // 결제창을 그냥 닫은 경우는 오류가 아니다
      if (!isUserCancel(e)) setError(e instanceof Error ? e.message : '결제를 시작하지 못했어요')
    } finally {
      setBusy(false)
    }
  }

  async function payMock() {
    if (!prep) return
    setBusy(true)
    setError('')
    try {
      await api<PaymentConfirmResult>('/payments/confirm', {
        method: 'POST',
        json: { paymentKey: `mock_${Date.now()}`, orderId: prep.orderId, amount: prep.amount },
      })
      navigate('/orders', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : '결제 실패')
    } finally {
      setBusy(false)
    }
  }

  if (!prep) {
    return error ? (
      <div className="card checkout">
        <Alert>{error}</Alert>
        <Link to="/orders">← 주문으로 돌아가기</Link>
      </div>
    ) : (
      <div className="card checkout" aria-busy="true">
        <div className="skeleton" style={{ height: 28, width: '40%' }} />
        <div className="skeleton" style={{ height: 76 }} />
        <div className="skeleton" style={{ height: 50 }} />
      </div>
    )
  }

  return (
    <div className="card checkout">
      <h1>결제하기</h1>

      <div className="summary">
        <div>
          <span className="price-label">주문 상품</span>
          <b>{prep.orderName}</b>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className="price-label">결제 금액</span>
          <Price value={prep.amount} className="price big num" />
        </div>
      </div>

      {prep.mode === 'off' && <Alert>결제 기능이 아직 준비되지 않았어요.</Alert>}

      {prep.mode === 'mock' && (
        <>
          <Alert kind="notice">개발용 모의 결제예요. 실제로 돈이 결제되지 않아요.</Alert>
          <button className="btn-lg btn-block" onClick={payMock} disabled={busy}>
            {busy ? '처리 중...' : '모의 결제 승인'}
          </button>
        </>
      )}

      {prep.mode === 'toss' && (
        <>
          <div id="payment-method" />
          <div id="agreement" />
          <button className="btn-lg btn-block" onClick={payWithToss} disabled={busy || !widgetReady}>
            <Icon name="card" size={18} />
            {widgetReady ? `${prep.amount.toLocaleString('ko-KR')}원 결제하기` : '결제창 준비 중...'}
          </button>
        </>
      )}

      {error && <Alert>{error}</Alert>}
      <Link to="/orders" className="muted" style={{ textAlign: 'center' }}>
        ← 주문으로 돌아가기
      </Link>
    </div>
  )
}
