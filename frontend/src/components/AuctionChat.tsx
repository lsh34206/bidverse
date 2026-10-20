import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { useSocket } from '../socket.tsx'
import { initial } from '../time.ts'
import { MAX_CHAT_LENGTH, won } from '../types.ts'
import type { BidEvent, ChatMessage, ChatPage } from '../types.ts'
import { Icon } from './Icon.tsx'

type Item =
  | { kind: 'chat'; at: number; msg: ChatMessage }
  | { kind: 'system'; at: number; id: string; text: string }

const PAGE = 50
const GROUP_GAP_MS = 5 * 60_000

const toItem = (msg: ChatMessage): Item => ({ kind: 'chat', at: new Date(msg.createdAt).getTime(), msg })
const itemId = (i: Item) => (i.kind === 'chat' ? i.msg.id : i.id)
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })

/** 이미 있는 항목은 건너뛰고 시간순으로 합친다 (소켓 이벤트와 REST 응답이 겹쳐 와도 한 번만 보이게) */
function merge(prev: Item[], incoming: Item[]): Item[] {
  const seen = new Set(prev.map(itemId))
  const fresh = incoming.filter((i) => !seen.has(itemId(i)))
  return fresh.length === 0 ? prev : [...prev, ...fresh].sort((a, b) => a.at - b.at)
}

interface Props {
  auctionId: string
  userId?: string
  /** 로그인한 사용자 (없으면 읽기만 가능) */
  loggedIn: boolean
  /** 판매자·관리자는 남의 메시지도 지울 수 있다 */
  canModerate: boolean
  /** 채팅이 닫힌 이유 (종료/중지). null 이면 열려 있다. */
  closedReason: string | null
  /** 지금 이 경매를 보고 있는 사람 수 */
  viewers?: number
}

/** 경매 상세에서 입찰창 옆에 붙는 실시간 채팅. 입찰이 들어오면 시스템 메시지로 같이 흐른다. */
export default function AuctionChat({ auctionId, userId, loggedIn, canModerate, closedReason, viewers }: Props) {
  const socket = useSocket()
  const [items, setItems] = useState<Item[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [unseen, setUnseen] = useState(0)

  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // 맨 아래를 보고 있으면 새 메시지가 오면 따라 내려간다
  const restore = useRef<number | null>(null) // 이전 메시지를 위에 붙일 때 스크롤 위치 유지용
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = useCallback(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
    stick.current = true
    setUnseen(0)
  }, [])

  // 최근 내역 불러오기 (처음 + 소켓이 끊겼다 돌아왔을 때 놓친 메시지 보충)
  const loadLatest = useCallback(async () => {
    try {
      const page = await api<ChatPage>(`/auctions/${auctionId}/chat?limit=${PAGE}`)
      setItems((prev) => merge(prev, page.items.map(toItem)))
      setHasMore((h) => h || page.hasMore)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '채팅을 불러오지 못했어요')
    } finally {
      setLoading(false)
    }
  }, [auctionId])

  useEffect(() => {
    setItems([])
    setLoading(true)
    stick.current = true
    void loadLatest()
  }, [loadLatest])

  async function loadOlder() {
    const firstChat = items.find((i) => i.kind === 'chat')
    if (!firstChat || firstChat.kind !== 'chat' || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await api<ChatPage>(`/auctions/${auctionId}/chat?limit=${PAGE}&before=${firstChat.msg.id}`)
      restore.current = listRef.current?.scrollHeight ?? null
      setItems((prev) => merge(prev, page.items.map(toItem)))
      setHasMore(page.hasMore)
    } catch (e) {
      setError(e instanceof Error ? e.message : '이전 메시지를 불러오지 못했어요')
    } finally {
      setLoadingOlder(false)
    }
  }

  // 실시간: 새 채팅, 삭제, 입찰(시스템 메시지)
  useEffect(() => {
    if (!socket) return
    const onChat = (msg: ChatMessage) => {
      if (msg.auctionId !== auctionId) return
      setItems((prev) => merge(prev, [toItem(msg)]))
      if (!stick.current && msg.userId !== userId) setUnseen((n) => n + 1)
    }
    const onDeleted = (e: { auctionId: string; messageId: string }) => {
      if (e.auctionId !== auctionId) return
      setItems((prev) => prev.filter((i) => !(i.kind === 'chat' && i.msg.id === e.messageId)))
    }
    const onBid = (e: BidEvent) => {
      if (e.auctionId !== auctionId) return
      const base = { kind: 'system' as const, at: Date.now() }
      const lines: Item[] = [{ ...base, id: `bid-${e.bid.id || e.bidCount}`, text: `${e.bid.bidder}님이 ${won(e.bid.amount)}에 입찰했어요` }]
      if (e.extended) lines.push({ ...base, id: `ext-${e.bidCount}`, text: '마감 직전 입찰로 마감 시간이 5분 연장됐어요' })
      setItems((prev) => merge(prev, lines))
    }
    const onReconnect = () => void loadLatest()

    socket.on('chat:new', onChat)
    socket.on('chat:deleted', onDeleted)
    socket.on('bid:new', onBid)
    socket.io.on('reconnect', onReconnect)
    return () => {
      socket.off('chat:new', onChat)
      socket.off('chat:deleted', onDeleted)
      socket.off('bid:new', onBid)
      socket.io.off('reconnect', onReconnect)
    }
  }, [socket, auctionId, userId, loadLatest])

  // 항목이 바뀐 뒤 스크롤 처리 (그리기 전에 맞춰서 깜빡이지 않게)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (restore.current !== null) {
      el.scrollTop += el.scrollHeight - restore.current
      restore.current = null
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [items])

  function onScroll() {
    const el = listRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    stick.current = atBottom
    if (atBottom) setUnseen(0)
  }

  async function send(e?: FormEvent) {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError('')
    try {
      const msg = await api<ChatMessage>(`/auctions/${auctionId}/chat`, { method: 'POST', json: { text } })
      setDraft('')
      stick.current = true // 내가 보낸 메시지는 항상 보이게
      setItems((prev) => merge(prev, [toItem(msg)]))
      if (inputRef.current) inputRef.current.style.height = ''
    } catch (err) {
      setError(err instanceof Error ? err.message : '메시지를 보내지 못했어요')
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 한글 조합 중의 Enter 는 글자 확정이므로 전송하지 않는다.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  async function remove(id: string) {
    if (!confirm('이 메시지를 삭제할까요?')) return
    try {
      await api(`/auctions/${auctionId}/chat/${id}`, { method: 'DELETE' })
      setItems((prev) => prev.filter((i) => !(i.kind === 'chat' && i.msg.id === id)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '삭제하지 못했어요')
    }
  }

  // 같은 사람이 연달아 보낸 메시지는 이름/아바타를 한 번만 보여준다.
  const rows = useMemo(
    () =>
      items.map((item, i) => {
        const prev = items[i - 1]
        const head =
          item.kind === 'chat' &&
          !(prev && prev.kind === 'chat' && prev.msg.userId === item.msg.userId && item.at - prev.at < GROUP_GAP_MS)
        return { item, head }
      }),
    [items],
  )

  const over = [...draft].length > MAX_CHAT_LENGTH
  const nearLimit = [...draft].length > MAX_CHAT_LENGTH - 60

  return (
    <section className="card chat" aria-label="실시간 채팅">
      <header className="chat-head">
        <h2>
          <Icon name="chat" size={18} />
          실시간 채팅
        </h2>
        {viewers !== undefined && viewers > 0 && (
          <span className="viewers" title="지금 이 경매를 보고 있는 사람">
            <span className="dot" />
            {viewers.toLocaleString('ko-KR')}명 보는 중
          </span>
        )}
      </header>

      <div className="chat-list" ref={listRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        {hasMore && (
          <button className="link chat-older" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? '불러오는 중...' : '이전 메시지 더 보기'}
          </button>
        )}
        {loading && <div className="chat-empty muted">불러오는 중...</div>}
        {!loading && items.length === 0 && (
          <div className="chat-empty">
            <Icon name="chat" size={26} />
            <b>아직 대화가 없어요</b>
            <span className="muted">궁금한 점을 판매자에게 물어보거나, 다른 입찰자와 이야기해 보세요.</span>
          </div>
        )}

        {rows.map(({ item, head }) => {
          if (item.kind === 'system') {
            return (
              <div key={item.id} className="chat-system">
                <span>{item.text}</span>
              </div>
            )
          }
          const m = item.msg
          const mine = m.userId === userId
          return (
            <div key={m.id} className={`chat-msg${mine ? ' mine' : ''}${head ? ' head' : ''}`}>
              {!mine && (head ? <span className="avatar sm">{initial(m.nickname)}</span> : <span className="avatar-gap" />)}
              <div className="chat-body">
                {head && !mine && (
                  <div className="chat-name">
                    {m.nickname}
                    {m.isSeller && <span className="role seller">판매자</span>}
                    {m.isAdmin && <span className="role admin">운영자</span>}
                  </div>
                )}
                <div className="bubble-row">
                  {mine && <time className="chat-time">{hhmm(item.at)}</time>}
                  <div className="bubble">{m.text}</div>
                  {!mine && <time className="chat-time">{hhmm(item.at)}</time>}
                  {(mine || canModerate) && (
                    <button
                      type="button"
                      className="chat-del"
                      onClick={() => remove(m.id)}
                      aria-label="메시지 삭제"
                      title="삭제"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {unseen > 0 && (
        <button className="chat-jump" onClick={scrollToBottom}>
          새 메시지 {unseen}개 <Icon name="arrowDown" size={14} />
        </button>
      )}

      {error && (
        <div className="chat-error" role="alert">
          {error}
        </div>
      )}

      {closedReason ? (
        <div className="chat-closed">
          <Icon name="info" size={16} />
          {closedReason}
        </div>
      ) : loggedIn ? (
        <form className="chat-form" onSubmit={send}>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="메시지를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"
            aria-label="채팅 메시지"
            onChange={(e) => {
              setDraft(e.target.value)
              // 입력 줄 수에 맞춰 높이를 늘린다 (최대 4줄)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 96)}px`
            }}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="send" disabled={sending || !draft.trim() || over} aria-label="보내기">
            <Icon name="send" size={18} />
          </button>
          {nearLimit && (
            <span className={`chat-count${over ? ' over' : ''}`}>
              {[...draft].length}/{MAX_CHAT_LENGTH}
            </span>
          )}
        </form>
      ) : (
        <div className="chat-closed">
          <Link to="/login" state={{ from: `/auctions/${auctionId}` }}>
            로그인
          </Link>
          하고 대화에 참여해 보세요
        </div>
      )}
    </section>
  )
}
