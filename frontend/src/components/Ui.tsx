import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon.tsx'
import type { IconName } from './Icon.tsx'

export function EmptyState({
  icon = 'box',
  title,
  children,
}: {
  icon?: IconName
  title: string
  children?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <h3>{title}</h3>
      {children && <div>{children}</div>}
    </div>
  )
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'notice'; children: ReactNode }) {
  return (
    <div className={kind} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon name={kind === 'error' ? 'alert' : 'info'} size={18} style={{ flex: 'none', marginTop: 2 }} />
      <span>{children}</span>
    </div>
  )
}

export function CardSkeletons({ count = 8 }: { count?: number }) {
  return (
    <div className="grid" aria-busy="true" aria-label="불러오는 중">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card auction-card">
          <div className="skeleton" style={{ aspectRatio: '4 / 3', borderRadius: 0 }} />
          <div className="card-body">
            <div className="skeleton" style={{ height: 12, width: '40%' }} />
            <div className="skeleton" style={{ height: 16, width: '90%' }} />
            <div className="skeleton" style={{ height: 16, width: '65%' }} />
            <div className="skeleton" style={{ height: 24, width: '50%', marginTop: 10 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {children}
    </div>
  )
}

type Theme = 'light' | 'dark' | null

/** 시스템 설정을 따르다가, 버튼을 누르면 라이트/다크를 직접 고르고 기억한다. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = document.documentElement.dataset.theme
    return t === 'light' || t === 'dark' ? t : null
  })
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const dark = theme ? theme === 'dark' : systemDark

  function toggle() {
    const next: Theme = dark ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next!
    try {
      localStorage.setItem('bidverse.theme', next!)
    } catch {
      // 저장이 막혀 있어도 이번 방문에는 적용된다.
    }
  }

  return (
    <button className="nav-link" onClick={toggle} aria-label={dark ? '라이트 모드로 전환' : '다크 모드로 전환'} title="테마 전환">
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  )
}
