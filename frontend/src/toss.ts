/** 토스페이먼츠 결제위젯 SDK(v2) 최소 타입과 로더 */
const SDK_URL = 'https://js.tosspayments.com/v2/standard'

export interface TossWidgets {
  setAmount(amount: { currency: 'KRW'; value: number }): Promise<void>
  renderPaymentMethods(opts: { selector: string; variantKey?: string }): Promise<{ destroy(): Promise<void> }>
  renderAgreement(opts: { selector: string; variantKey?: string }): Promise<{ destroy(): Promise<void> }>
  requestPayment(opts: {
    orderId: string
    orderName: string
    successUrl: string
    failUrl: string
    customerEmail?: string
    customerName?: string
  }): Promise<void>
}

interface TossPaymentsInstance {
  widgets(opts: { customerKey: string }): TossWidgets
}

declare global {
  interface Window {
    TossPayments?: (clientKey: string) => TossPaymentsInstance
  }
}

let loading: Promise<void> | null = null

/** SDK 스크립트를 한 번만 불러온다 */
export function loadTossSdk(): Promise<void> {
  if (window.TossPayments) return Promise.resolve()
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SDK_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      loading = null // 다음에 다시 시도할 수 있게
      reject(new Error('결제 모듈을 불러오지 못했어요. 네트워크를 확인해 주세요'))
    }
    document.head.appendChild(script)
  })
  return loading
}

export function createWidgets(clientKey: string, customerKey: string): TossWidgets {
  if (!window.TossPayments) throw new Error('결제 모듈이 준비되지 않았어요')
  return window.TossPayments(clientKey).widgets({ customerKey })
}

/** 사용자가 결제창을 닫았을 때 SDK가 던지는 에러인지 */
export const isUserCancel = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'USER_CANCEL'
