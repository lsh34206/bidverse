import { useEffect, useState } from 'react'

/** 일정 간격으로 현재 시각을 갱신한다. 카운트다운을 그리는 컴포넌트가 하나의 타이머만 쓰게 하려고 상위에서 호출한다. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 상세 화면용 정밀 카운트다운: `2일 03:12:09` / `00:42:10` */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const hms = `${pad(h)}:${pad(m)}:${pad(s)}`
  return days > 0 ? `${days}일 ${hms}` : hms
}

/** 카드용 간단한 남은 시간: `2일 3시간` / `45분` / `곧 종료` */
export function remaining(ms: number): string {
  if (ms <= 0) return '종료'
  const min = Math.floor(ms / 60_000)
  const days = Math.floor(min / 1440)
  const hours = Math.floor((min % 1440) / 60)
  const mins = min % 60
  if (days > 0) return `${days}일 ${hours}시간`
  if (hours > 0) return `${hours}시간 ${mins}분`
  if (min > 0) return `${min}분`
  return '1분 미만'
}

/** 1시간 미만이면 마감 임박으로 본다 */
export const isUrgent = (ms: number) => ms > 0 && ms < 60 * 60 * 1000

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/** 닉네임 첫 글자 (아바타용). 마스킹된 `h***` 도 첫 글자만 쓴다. */
export const initial = (name: string | null | undefined) => [...(name ?? '?')][0]?.toUpperCase() ?? '?'
