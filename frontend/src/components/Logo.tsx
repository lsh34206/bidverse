import { useId } from 'react'

/** 브랜드 마크 (경매 망치). favicon.svg 와 같은 모양이다. */
export function LogoMark({ size = 32 }: { size?: number }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4f46e5" />
          <stop offset="1" stopColor="#c026d3" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <g fill="#fff" transform="rotate(-35 16 15)">
        <rect x="8.5" y="5" width="15" height="7.5" rx="2.2" />
        <rect x="14" y="11" width="4" height="14" rx="2" />
      </g>
      <rect x="6.5" y="25.5" width="14" height="3" rx="1.5" fill="#fff" opacity=".92" />
    </svg>
  )
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <>
      <LogoMark size={size} />
      <span className="word">
        Bid<b>Verse</b>
      </span>
    </>
  )
}
