export type AuctionStatus = 'scheduled' | 'live' | 'ended'

export interface User {
  id: string
  email: string
  nickname: string
  role: string
}

export interface Auction {
  id: string
  seller: { id: string; nickname: string | null }
  title: string
  description: string
  category: string
  images: string[]
  startPrice: number
  currentPrice: number
  minIncrement: number
  buyNowPrice: number | null
  bidCount: number
  minNextBid: number
  highestBidderId: string | null
  startsAt: string
  endsAt: string
  status: AuctionStatus
  /** 정산이 끝난 경매의 결과. 정산 전이면 null */
  result: 'sold' | 'unsold' | null
  /** 관리자에 의해 중지된 경매 */
  suspended: boolean
  /** 중지 사유 (관리자 조회에만 채워짐) */
  suspendedReason: string | null
  createdAt: string
}

export interface Bid {
  id: string
  amount: number
  bidder: string
  createdAt: string
}

/** 입찰 성공 응답과 소켓 `bid:new` 이벤트가 공유하는 형태 */
export interface BidUpdate {
  bid: Bid
  currentPrice: number
  bidCount: number
  minNextBid: number
  highestBidderId: string
  endsAt: string
  /** 이 입찰로 마감 시각이 연장되었는지 */
  extended: boolean
}

export interface BidEvent extends BidUpdate {
  auctionId: string
}

export interface EndedEvent {
  auctionId: string
  result: 'sold' | 'unsold'
  winner?: string
  finalPrice?: number
}

export type NotifyType =
  | 'outbid'
  | 'won'
  | 'sold'
  | 'unsold'
  | 'ending'
  | 'suspended'
  | 'restored'
  | 'paid'
  | 'refunded'

export interface NotifyEvent {
  type: NotifyType
  auctionId: string
  title: string
  amount?: number
  orderId?: string
  message?: string
  /** 알림 센터에 저장된 알림이면 그 id */
  id?: string
  createdAt?: string
}

/** 알림 센터 목록의 항목 */
export interface NotificationItem {
  id: string
  type: NotifyType
  auctionId: string
  title: string
  amount: number | null
  orderId: string | null
  message: string | null
  read: boolean
  createdAt: string
}

export interface NotificationPage {
  items: NotificationItem[]
  total: number
  unreadCount: number
  page: number
  limit: number
}

/** 알림 한 건을 사람이 읽을 문장으로 바꾼다. 토스트와 알림 센터가 같이 쓴다. */
export function describeNotification(n: {
  type: NotifyType
  title: string
  amount?: number | null
  message?: string | null
}): { heading: string; text: string; tone: 'ok' | 'warn' | 'muted' } {
  const amount = won(n.amount ?? 0)
  switch (n.type) {
    case 'outbid':
      return { heading: '상회 입찰', tone: 'warn', text: `「${n.title}」에 ${amount} 입찰이 들어왔습니다.` }
    case 'won':
      return {
        heading: '낙찰',
        tone: 'ok',
        text: `「${n.title}」을(를) ${amount}에 낙찰받았습니다. 주문에서 결제를 진행하세요.`,
      }
    case 'sold':
      return { heading: '판매 완료', tone: 'ok', text: `「${n.title}」이(가) ${amount}에 낙찰되었습니다.` }
    case 'unsold':
      return { heading: '유찰', tone: 'muted', text: `「${n.title}」은(는) 입찰 없이 종료되었습니다.` }
    case 'ending':
      return {
        heading: '마감 임박',
        tone: 'warn',
        text: `관심 경매 「${n.title}」이(가) 1시간 안에 마감됩니다. (현재 ${amount})`,
      }
    case 'suspended':
      return {
        heading: '경매 중지',
        tone: 'warn',
        text: `「${n.title}」이(가) 관리자에 의해 중지되었습니다.${n.message ? ` 사유: ${n.message}` : ''}`,
      }
    case 'restored':
      return { heading: '경매 복구', tone: 'ok', text: `「${n.title}」의 중지가 해제되었습니다.` }
    case 'paid':
      return {
        heading: '결제 완료',
        tone: 'ok',
        text: `「${n.title}」 ${amount} 결제가 완료되었습니다. 주문에서 발송 처리를 해 주세요.`,
      }
    case 'refunded':
      return {
        heading: '환불',
        tone: 'warn',
        text: `「${n.title}」 ${amount} 결제가 환불되었습니다.${n.message ? ` 사유: ${n.message}` : ''}`,
      }
  }
}

export interface AdminStats {
  users: number
  auctions: number
  liveAuctions: number
  suspendedAuctions: number
  bids: number
  orders: number
  openReports: number
}

export interface AdminUser {
  id: string
  email: string
  nickname: string
  role: 'buyer' | 'seller' | 'admin'
  status: 'active' | 'banned'
  bannedReason: string | null
  createdAt: string
}

export interface AdminReport {
  id: string
  auction: { id: string; title: string; suspended: boolean }
  reporter: { id: string; nickname: string | null }
  reason: string
  status: 'open' | 'resolved'
  resolution: 'suspended' | 'dismissed' | null
  note: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface AuditEntry {
  id: string
  admin: string
  action: string
  targetType: string
  targetId: string
  detail: Record<string, unknown> | null
  createdAt: string
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'done' | 'refunded'

export interface Order {
  id: string
  auctionId: string
  title: string
  finalPrice: number
  status: OrderStatus
  role: 'buyer' | 'seller'
  buyer: { id: string; nickname: string | null }
  seller: { id: string; nickname: string | null }
  createdAt: string
  paidAt: string | null
  shippedAt: string | null
  completedAt: string | null
  refundedAt: string | null
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: '결제 대기',
  paid: '결제 완료',
  shipped: '발송됨',
  done: '거래 완료',
  refunded: '환불됨',
}

/** 결제 시작 시 서버가 내려주는 값 */
export interface PaymentPrepare {
  mode: 'toss' | 'mock' | 'off'
  clientKey: string | null
  customerKey: string
  /** 토스 결제창에 넘길 주문번호 (우리 주문 id가 아니다) */
  orderId: string
  orderName: string
  amount: number
}

export interface PaymentConfirmResult {
  status: 'paid' | 'waiting_for_deposit'
  order: Order
  receiptUrl?: string
  virtualAccount?: { bankCode?: string; accountNumber?: string; dueDate?: string }
}

/** 경매 채팅방 메시지 한 건 (REST 응답과 소켓 이벤트가 같은 모양) */
export interface ChatMessage {
  id: string
  auctionId: string
  userId: string
  nickname: string
  text: string
  isSeller: boolean
  isAdmin: boolean
  createdAt: string
}

export interface ChatPage {
  /** 오래된 것 → 최근 것 순서 */
  items: ChatMessage[]
  hasMore: boolean
}

export const MAX_CHAT_LENGTH = 300

export interface AuctionPage {
  items: Auction[]
  total: number
  page: number
  limit: number
}

export const STATUS_LABEL: Record<AuctionStatus, string> = {
  scheduled: '예정',
  live: '진행 중',
  ended: '종료',
}

export const CATEGORIES = ['etc', '전자기기', '패션', '수집품', '가구', '도서', '스포츠'] as const

export const won = (n: number) => `${n.toLocaleString('ko-KR')}원`
