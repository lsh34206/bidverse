import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api.ts'
import { Price } from '../components/AuctionCard.tsx'
import { Icon } from '../components/Icon.tsx'
import type { PaymentConfirmResult } from '../types.ts'

/**
 * 토스 결제창 인증이 끝나면 successUrl 로 돌아온다. 쿼리의 paymentKey/orderId/amount 를 서버에 넘겨 승인한다.
 * 금액은 서버가 저장해 둔 값과 대조하므로, 쿼리를 바꿔도 다른 금액으로 승인되지 않는다.
 */
export function PaymentSuccess() {
  const [params] = useSearchParams()
  const [result, setResult] = useState<PaymentConfirmResult | null>(null)
  const [error, setError] = useState('')
  const started = useRef(false) // StrictMode 의 이중 실행으로 승인을 두 번 보내지 않게

  const paymentKey = params.get('paymentKey')
  const orderId = params.get('orderId')
  const amount = Number(params.get('amount'))

  useEffect(() => {
    if (started.current) return
    started.current = true
    if (!paymentKey || !orderId || !Number.isFinite(amount)) {
      setError('결제 정보가 올바르지 않아요')
      return
    }
    api<PaymentConfirmResult>('/payments/confirm', {
      method: 'POST',
      json: { paymentKey, orderId, amount },
    })
      .then(setResult)
      .catch((e: Error) => setError(e.message))
  }, [paymentKey, orderId, amount])

  if (error) {
    return (
      <div className="card checkout centered">
        <span className="result-icon bad">
          <Icon name="alert" size={30} />
        </span>
        <h1>결제를 완료하지 못했어요</h1>
        <p className="error" style={{ textAlign: 'left', width: '100%' }}>
          {error}
        </p>
        <p className="muted">
          결제 금액이 빠져나갔다면 잠시 뒤 주문에서 상태를 확인해 주세요. 승인 결과가 확인되면 자동으로 반영돼요.
        </p>
        <Link className="button btn-block" to="/orders">
          내 주문 보기
        </Link>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="card checkout centered" aria-busy="true">
        <span className="result-icon wait">
          <Icon name="clock" size={30} />
        </span>
        <h1>결제를 확인하는 중이에요</h1>
        <p className="muted">잠시만 기다려 주세요. 창을 닫지 마세요.</p>
      </div>
    )
  }

  return (
    <div className="card checkout centered">
      {result.status === 'paid' ? (
        <>
          <span className="result-icon">
            <Icon name="check" size={32} />
          </span>
          <h1>결제가 완료되었어요</h1>
          <Price value={result.order.finalPrice} className="price big num" />
          <p className="muted">{result.order.title}</p>
          {result.receiptUrl && result.receiptUrl.startsWith('https://') && (
            <a href={result.receiptUrl} target="_blank" rel="noreferrer">
              영수증 보기
            </a>
          )}
        </>
      ) : (
        <>
          <span className="result-icon wait">
            <Icon name="clock" size={30} />
          </span>
          <h1>입금을 기다리고 있어요</h1>
          <p className="muted">가상계좌로 입금하면 결제가 완료돼요.</p>
          {result.virtualAccount?.accountNumber && (
            <p className="price num">계좌번호 {result.virtualAccount.accountNumber}</p>
          )}
        </>
      )}
      <Link className="button btn-block" to="/orders">
        내 주문 보기
      </Link>
    </div>
  )
}

/** failUrl: 결제창에서 실패하거나 인증에 실패했을 때. 이 단계에서는 승인 API를 호출하면 안 된다. */
export function PaymentFail() {
  const [params] = useSearchParams()
  return (
    <div className="card checkout centered">
      <span className="result-icon bad">
        <Icon name="x" size={32} />
      </span>
      <h1>결제에 실패했어요</h1>
      <p className="error" style={{ textAlign: 'left', width: '100%' }}>
        {params.get('message') ?? '알 수 없는 오류'}
      </p>
      {params.get('code') && <p className="muted">오류 코드: {params.get('code')}</p>}
      <Link className="button btn-block" to="/orders">
        주문으로 돌아가 다시 결제하기
      </Link>
    </div>
  )
}
