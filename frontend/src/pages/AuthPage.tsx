import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.tsx'
import { Icon } from '../components/Icon.tsx'
import { Alert } from '../components/Ui.tsx'

const PERKS = ['입찰이 들어오는 순간 화면이 바로 바뀌어요', '마감 직전 입찰은 자동으로 시간이 연장돼요', '토스페이먼츠로 안전하게 결제해요']

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'
  const isLogin = mode === 'login'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (isLogin) await login(email, password)
      else await register(email, password, nickname)
      navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <aside className="auth-aside">
        <h2>
          지금 이 순간,
          <br />
          가장 뜨거운 경매
        </h2>
        <p>BidVerse에서 원하는 물건을 실시간으로 입찰하고 낙찰받아 보세요.</p>
        <ul>
          {PERKS.map((p) => (
            <li key={p}>
              <Icon name="check" size={20} />
              {p}
            </li>
          ))}
        </ul>
      </aside>

      <form className="auth-form" onSubmit={onSubmit}>
        <div>
          <h1>{isLogin ? '다시 만나서 반가워요' : '회원가입'}</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            {isLogin ? '이메일과 비밀번호로 로그인해 주세요.' : '30초면 가입할 수 있어요.'}
          </p>
        </div>

        <label>
          이메일
          <input
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        {!isLogin && (
          <label>
            닉네임
            <input
              autoComplete="nickname"
              placeholder="2~20자"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              minLength={2}
              maxLength={20}
              required
            />
          </label>
        )}
        <label>
          비밀번호
          <input
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            placeholder={isLogin ? '비밀번호' : '8자 이상'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={isLogin ? undefined : 8}
            required
          />
        </label>

        {error && <Alert>{error}</Alert>}
        <button className="btn-lg btn-block" disabled={busy}>
          {busy ? '잠시만요...' : isLogin ? '로그인' : '가입하고 시작하기'}
        </button>
        <p className="muted" style={{ textAlign: 'center' }}>
          {isLogin ? (
            <>
              아직 계정이 없나요? <Link to="/register">회원가입</Link>
            </>
          ) : (
            <>
              이미 계정이 있나요? <Link to="/login">로그인</Link>
            </>
          )}
        </p>
      </form>
    </div>
  )
}
