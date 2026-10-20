import type { ReactNode } from 'react'
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth.tsx'
import AdminPage from './pages/AdminPage.tsx'
import AuctionDetail from './pages/AuctionDetail.tsx'
import AuctionForm from './pages/AuctionForm.tsx'
import AuctionList from './pages/AuctionList.tsx'
import AuthPage from './pages/AuthPage.tsx'
import CheckoutPage from './pages/CheckoutPage.tsx'
import NotificationsPage from './pages/NotificationsPage.tsx'
import { PaymentFail, PaymentSuccess } from './pages/PaymentResultPage.tsx'
import Orders from './pages/Orders.tsx'
import WatchlistPage from './pages/WatchlistPage.tsx'
import { Icon } from './components/Icon.tsx'
import { Logo } from './components/Logo.tsx'
import { ThemeToggle } from './components/Ui.tsx'
import { initial } from './time.ts'
import Notifications from './Notifications.tsx'
import { SocketProvider } from './socket.tsx'
import { UnreadProvider, useUnread } from './unread.tsx'

function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <div className="skeleton" style={{ height: 240 }} aria-busy="true" />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />
  return children
}

function Bell() {
  const { unread } = useUnread()
  return (
    <NavLink to="/notifications" className="nav-link" aria-label={`알림 ${unread}개 안 읽음`} title="알림">
      <Icon name="bell" />
      {unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
    </NavLink>
  )
}

function Header() {
  const { user, logout } = useAuth()
  const link = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? ' active' : ''}`
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link to="/" className="brand" aria-label="BidVerse 홈">
          <Logo />
        </Link>
        <nav className="nav" aria-label="주요 메뉴">
          {user ? (
            <>
              <NavLink to="/auctions/new" className={link}>
                <Icon name="plus" />
                <span className="label">경매 등록</span>
              </NavLink>
              <NavLink to="/watchlist" className={link} title="관심 경매">
                <Icon name="heart" />
                <span className="label">관심</span>
              </NavLink>
              <NavLink to="/orders" className={link} title="내 주문">
                <Icon name="receipt" />
                <span className="label">주문</span>
              </NavLink>
              {user.role === 'admin' && (
                <NavLink to="/admin" className={link} title="관리자">
                  <Icon name="shield" />
                  <span className="label">관리자</span>
                </NavLink>
              )}
              <Bell />
              <ThemeToggle />
              <span className="nav-sep" />
              <span className="user-chip">
                <span className="avatar">{initial(user.nickname)}</span>
                <span className="name">{user.nickname}</span>
              </span>
              <button className="nav-link" onClick={logout} aria-label="로그아웃" title="로그아웃">
                <Icon name="logout" />
              </button>
            </>
          ) : (
            <>
              <ThemeToggle />
              <NavLink to="/login" className={link}>
                로그인
              </NavLink>
              <Link to="/register" className="button inline">
                회원가입
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <span className="brand" style={{ fontSize: '1rem' }}>
          <Logo size={24} />
        </span>
        <span>실시간으로 경쟁하고, 안전하게 거래하는 통합 경매 플랫폼</span>
        <span>© {new Date().getFullYear()} BidVerse</span>
      </div>
    </footer>
  )
}

function AdminRoute() {
  const { user } = useAuth()
  return <AdminPage selfId={user?.id ?? ''} />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SocketProvider>
          <UnreadProvider>
            <div className="app">
            <Header />
            <Notifications />
            <main className="container">
              <Routes>
                <Route path="/" element={<AuctionList />} />
                <Route path="/login" element={<AuthPage mode="login" />} />
                <Route path="/register" element={<AuthPage mode="register" />} />
                <Route
                  path="/auctions/new"
                  element={
                    <RequireAuth>
                      <AuctionForm />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/orders"
                  element={
                    <RequireAuth>
                      <Orders />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/orders/:id/pay"
                  element={
                    <RequireAuth>
                      <CheckoutPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/payments/success"
                  element={
                    <RequireAuth>
                      <PaymentSuccess />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/payments/fail"
                  element={
                    <RequireAuth>
                      <PaymentFail />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/notifications"
                  element={
                    <RequireAuth>
                      <NotificationsPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/watchlist"
                  element={
                    <RequireAuth>
                      <WatchlistPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <RequireAuth admin>
                      <AdminRoute />
                    </RequireAuth>
                  }
                />
                <Route path="/auctions/:id" element={<AuctionDetail />} />
                <Route
                  path="/auctions/:id/edit"
                  element={
                    <RequireAuth>
                      <AuctionForm />
                    </RequireAuth>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
            <Footer />
            </div>
          </UnreadProvider>
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
