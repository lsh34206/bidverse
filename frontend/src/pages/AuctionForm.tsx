import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.ts'
import { Alert, PageHead } from '../components/Ui.tsx'
import { CATEGORIES } from '../types.ts'
import type { Auction } from '../types.ts'

// <input type="datetime-local"> 은 타임존 없는 로컬 시각 문자열을 쓴다.
const toLocalInput = (iso: string) => {
  const d = new Date(iso)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

interface FormState {
  title: string
  description: string
  category: string
  images: string
  startPrice: string
  minIncrement: string
  buyNowPrice: string
  startsAt: string
  endsAt: string
}

const empty: FormState = {
  title: '',
  description: '',
  category: 'etc',
  images: '',
  startPrice: '',
  minIncrement: '1000',
  buyNowPrice: '',
  startsAt: '',
  endsAt: '',
}

export default function AuctionForm() {
  const { id } = useParams()
  const editing = id !== undefined
  const navigate = useNavigate()
  const [form, setForm] = useState<FormState>(empty)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!editing) return
    api<Auction>(`/auctions/${id}`)
      .then((a) =>
        setForm({
          title: a.title,
          description: a.description,
          category: a.category,
          images: a.images.join('\n'),
          startPrice: String(a.startPrice),
          minIncrement: String(a.minIncrement),
          buyNowPrice: a.buyNowPrice === null ? '' : String(a.buyNowPrice),
          startsAt: toLocalInput(a.startsAt),
          endsAt: toLocalInput(a.endsAt),
        }),
      )
      .catch((e: Error) => setError(e.message))
  }, [editing, id])

  const field = (key: keyof FormState) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }),
  })

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const body = {
      title: form.title,
      description: form.description,
      category: form.category,
      images: form.images.split('\n').map((s) => s.trim()).filter(Boolean),
      startPrice: Number(form.startPrice),
      minIncrement: Number(form.minIncrement),
      buyNowPrice: form.buyNowPrice ? Number(form.buyNowPrice) : undefined,
      startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : undefined,
      endsAt: new Date(form.endsAt).toISOString(),
    }
    try {
      const saved = await api<Auction>(editing ? `/auctions/${id}` : '/auctions', {
        method: editing ? 'PATCH' : 'POST',
        json: body,
      })
      navigate(`/auctions/${saved.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장 실패')
    } finally {
      setBusy(false)
    }
  }

  const imageList = form.images
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  return (
    <div className="form-narrow">
      <PageHead
        title={editing ? '경매 수정' : '경매 등록'}
        sub={editing ? '입찰이 시작되기 전까지만 수정할 수 있어요.' : '물건 정보와 경매 조건을 입력해 주세요.'}
      />
      <form className="card form" onSubmit={onSubmit}>
        <section className="form-section">
          <h2>기본 정보</h2>
          <label>
            제목
            <input {...field('title')} maxLength={100} placeholder="예) 빈티지 필름 카메라" required />
          </label>
          <label>
            카테고리
            <select {...field('category')}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c === 'etc' ? '기타' : c}
                </option>
              ))}
            </select>
          </label>
          <label>
            상품 설명
            <textarea
              {...field('description')}
              rows={6}
              maxLength={5000}
              placeholder="상태, 구성품, 거래 방법 등을 자세히 적을수록 입찰이 잘 들어와요."
            />
          </label>
        </section>

        <section className="form-section">
          <h2>이미지</h2>
          <label>
            이미지 주소
            <span className="hint">한 줄에 하나씩, 최대 10개. 첫 번째 이미지가 대표 이미지예요.</span>
            <textarea {...field('images')} rows={3} placeholder="https://..." />
          </label>
          {imageList.length > 0 && (
            <div className="image-previews">
              {imageList.slice(0, 10).map((src, i) => (
                <div key={`${src}-${i}`} className="preview">
                  <img src={src} alt="" onError={(e) => ((e.currentTarget.style.visibility = 'hidden'))} />
                  {i === 0 && <span>대표</span>}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="form-section">
          <h2>가격</h2>
          <div className="row">
            <label>
              시작가 (원)
              <input type="number" min={1} {...field('startPrice')} required />
            </label>
            <label>
              최소 입찰 단위 (원)
              <input type="number" min={1} {...field('minIncrement')} />
            </label>
            <label>
              즉시구매가 (원)
              <span className="hint">선택 · 시작가보다 커야 해요</span>
              <input type="number" min={1} {...field('buyNowPrice')} />
            </label>
          </div>
        </section>

        <section className="form-section">
          <h2>일정</h2>
          <div className="row">
            <label>
              시작 시각
              <span className="hint">비우면 등록 즉시 시작해요</span>
              <input type="datetime-local" {...field('startsAt')} />
            </label>
            <label>
              종료 시각
              <span className="hint">최대 30일 · 마감 5분 전 입찰이 들어오면 자동 연장돼요</span>
              <input type="datetime-local" {...field('endsAt')} required />
            </label>
          </div>
        </section>

        {error && <Alert>{error}</Alert>}
        <div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="secondary" onClick={() => navigate(-1)}>
            취소
          </button>
          <button className="btn-lg" disabled={busy}>
            {busy ? '저장 중...' : editing ? '저장하기' : '경매 등록하기'}
          </button>
        </div>
      </form>
    </div>
  )
}
