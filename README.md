# BidVerse — 통합 실시간 경매 플랫폼

입찰이 들어오는 순간 모든 화면이 바로 바뀌는 **실시간 경매 사이트**입니다.
경매 등록부터 입찰, 낙찰, 결제(토스페이먼츠), 배송 확인, 환불까지 한 곳에서 처리하고,
경매 상세 화면에서는 입찰하면서 다른 참여자와 **실시간 채팅**도 할 수 있습니다.

> 코드 구조와 내부 동작이 궁금하다면 [CODEME.md](./CODEME.md), 보안 설계가 궁금하다면 [SECURITY.md](./SECURITY.md)를 보세요.

---

## 목차

1. [주요 기능](#주요-기능)
2. [경매 규칙](#경매-규칙)
3. [기술 스택](#기술-스택)
4. [아키텍처](#아키텍처)
5. [빠른 시작](#빠른-시작)
6. [환경변수](#환경변수)
7. [npm 스크립트](#npm-스크립트)
8. [테스트](#테스트)
9. [결제(토스페이먼츠) 설정](#결제토스페이먼츠-설정)
10. [배포 (nginx + pm2, AWS EC2 Ubuntu)](#배포-nginx--pm2-aws-ec2-ubuntu)
11. [개발할 때 알아둘 점](#개발할-때-알아둘-점)
12. [현재 상태와 한계](#현재-상태와-한계)
13. [폴더 구조](#폴더-구조)
14. [라이선스](#라이선스)

---

## 주요 기능

### 경매 · 입찰
- **경매 등록/수정/삭제** — 제목, 설명, 카테고리, 이미지(URL), 시작가, 최소 입찰 단위, 즉시구매가, 시작·종료 시각
- **목록 검색** — 검색어, 카테고리, 상태(진행 중/예정/종료), 정렬(마감 임박/최신/가격), 페이지네이션
- **실시간 입찰** — 입찰이 성공하면 같은 경매를 보고 있는 모든 사용자 화면의 현재가·입찰 내역·남은 시간이 즉시 바뀝니다.
- **동시 입찰 안전** — 여러 명이 동시에 입찰해도 가격이 뒤집히거나 중복되지 않습니다. (원자적 조건부 업데이트)
- **스나이핑 방지** — 마감 5분 미만 남았을 때 입찰이 들어오면 마감이 `지금 + 5분`으로 자동 연장됩니다. (경매당 최대 20회)
- **즉시구매** — 즉시구매가로 바로 낙찰받고 경매가 그 자리에서 종료됩니다.
- **빠른 입찰 버튼** — 최소 입찰가, +1/+2/+5 단위 버튼

### 낙찰 · 주문 · 결제
- **자동 정산** — 종료된 경매를 서버가 5초마다 확인해 낙찰/유찰을 확정하고 주문을 만듭니다. 서버가 꺼져 있던 동안 끝난 경매도 다음 기동 때 처리됩니다.
- **토스페이먼츠 결제** — 결제위젯(v2)으로 결제하고, 서버가 금액을 다시 검증한 뒤 승인합니다.
- **주문 진행** — 결제 → 발송(판매자) → 수령 확인(구매자), 진행 단계를 스텝퍼로 표시
- **환불** — 구매자는 발송 전에 직접 취소, 관리자는 발송 이후에도 전액 환불
- **결제 안전장치** — 승인 응답이 유실돼도 중복 결제 없이 복구되고, 위조된 웹훅으로는 상태를 바꿀 수 없습니다.

### 소통 · 알림
- **실시간 채팅** — 경매 상세의 입찰창 옆에서 대화. 판매자/운영자 배지, 접속자 수, 입찰 알림이 채팅에 같이 흐릅니다.
- **알림 센터** — 상회 입찰, 낙찰, 판매 완료, 유찰, 결제 완료, 환불, 경매 중지/복구, 마감 임박. 실시간 토스트 + 저장된 알림 목록 + 안 읽은 수 배지
- **관심 경매** — 담아 두면 마감 1시간 전에 알림을 보냅니다.

### 운영
- **관리자 화면** — 통계, 신고 처리, 경매 중지/복구, 주문 환불, 사용자 정지·권한 변경, 감사 로그
- **신고** — 사용자가 경매를 신고하면 관리자가 중지 또는 기각
- **보안** — JWT 인증, 비밀번호 해시(bcrypt), 속도 제한(로그인·가입·입찰·채팅 등), 정지된 계정 즉시 차단

### 화면
- 라이트/다크 모드(시스템 설정 따름 + 수동 전환), 모바일 대응, 로딩 스켈레톤

---

## 경매 규칙

| 항목 | 규칙 |
|---|---|
| 입찰가 | 첫 입찰은 **시작가 이상**, 이후는 **현재가 + 최소 입찰 단위 이상** |
| 입찰 불가 | 내 경매, 이미 내가 최고가인 경매, 시작 전/종료된 경매, 관리자가 중지한 경매 |
| 경매 기간 | 최대 30일 |
| 마감 연장 | 마감까지 5분 **미만** 남은 시점의 입찰마다 `지금 + 5분`으로 연장, 경매당 최대 20회 |
| 즉시구매 | 즉시구매가가 있고 현재가가 그보다 낮을 때만 가능, 구매 즉시 종료 |
| 수정·삭제 | 입찰이 하나도 없을 때만 가능 (유찰된 경매는 종료 시각을 다시 잡아 재등록 가능) |
| 주문 | 낙찰 시 경매당 **하나만** 생성, 결제 → 발송 → 수령 확인 순서로만 진행 |
| 환불 | 구매자: 결제 후 발송 전 / 관리자: 결제 이후 언제든 (전액) |
| 채팅 | 로그인한 사용자만 전송, 300자까지, 10초에 6건. 종료·중지된 경매는 읽기 전용 |
| 알림 | 90일 뒤 자동 삭제 |

---

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 | React 19, TypeScript, Vite 8, React Router 7, socket.io-client |
| 백엔드 | NestJS 12, TypeScript, Mongoose 9, Socket.IO 4 |
| 데이터베이스 | MongoDB (로컬 또는 Atlas) |
| 실시간 | Socket.IO (+ 다중 인스턴스용 Redis 어댑터, 선택) |
| 결제 | 토스페이먼츠 결제위젯 v2 + 결제 승인/취소 API |
| 인증 | JWT (`@nestjs/jwt`), bcryptjs |
| 속도 제한 | `@nestjs/throttler` (+ Redis 저장소, 선택) |
| 테스트 | Vitest, supertest, socket.io-client, mingo |
| 운영 | nginx, pm2, AWS EC2 Ubuntu |

---

## 아키텍처

```
                        ┌──────────── nginx ────────────┐
 브라우저 ──── HTTPS ───▶│ /          → frontend/dist    │
 (React)                │ /api/*     → NestJS (REST)    │
                        │ /socket.io → NestJS (WebSocket)│
                        └───────────────┬───────────────┘
                                        │
                              ┌─────────▼─────────┐        ┌────────────┐
                              │   NestJS (pm2)    │◀──────▶│  MongoDB   │
                              │  REST + Socket.IO │        └────────────┘
                              │  스케줄러 3종      │        ┌────────────┐
                              └─────────┬─────────┘───────▶│ Redis(선택) │
                                        │                  └────────────┘
                                        ▼
                              토스페이먼츠 API (결제 승인/취소/조회)
```

- 입찰은 **REST**로 받고, 결과는 **Socket.IO**로 같은 경매방(`auction:{id}`) 사람들에게 브로드캐스트합니다.
- 서버 시각이 기준입니다. 브라우저는 접속할 때 서버 시각과의 오차를 보정해 카운트다운만 그립니다.
- 스케줄러(정산, 마감 임박 알림, 결제 대사)는 DB에서 **원자적으로 선점**하는 방식이라 서버가 여러 대여도 중복 처리되지 않습니다.

---

## 빠른 시작

### 준비물
- **Node.js 22 이상** (개발은 22.x에서 진행)
- **MongoDB** — 로컬 `mongod` 또는 [MongoDB Atlas](https://www.mongodb.com/atlas) 무료 클러스터. 트랜잭션을 쓰지 않아서 레플리카셋이 아니어도 됩니다.

### 1. 백엔드

```bash
cd backend
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

`backend/.env`를 열어 `MONGODB_URI`와 `JWT_SECRET`을 채웁니다. (환경변수 표는 아래 참고)

```bash
npm run db:check            # (선택) DB 연결·쓰기 권한 점검. 접속 문자열은 출력하지 않습니다.
npm run start:dev           # http://localhost:3000/api  (파일 변경 시 자동 재시작)
```

### 2. 프론트엔드

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

개발 서버가 `/api`와 `/socket.io`를 `localhost:3000` 백엔드로 프록시하므로 별도 설정이 필요 없습니다.
다른 백엔드에 붙여 보려면 `VITE_API_TARGET` 환경변수를 지정하세요. (`frontend/vite.config.ts` 참고)

> 접속은 `localhost:5173`으로 하세요. Vite가 IPv6(`::1`)로만 떠서 `127.0.0.1:5173`은 열리지 않을 수 있습니다.

### 3. 첫 사용

1. `http://localhost:5173`에서 회원가입
2. **경매 등록**에서 경매를 만들고, 다른 계정으로 입찰해 보기
3. 키 없이도 **모의 결제**로 낙찰 → 결제 → 발송 → 수령 확인 흐름을 끝까지 확인할 수 있습니다.

### 관리자 계정 만들기

관리자는 API로는 만들 수 없고, 서버에서 직접 지정합니다. (가입을 먼저 해 두세요)

```bash
cd backend
npm run admin:grant  -- you@example.com     # 관리자로 지정
npm run admin:revoke -- you@example.com     # 일반 사용자로 되돌림
```

---

## 환경변수

`backend/.env` (예시는 [`backend/.env.example`](./backend/.env.example))

| 이름 | 필수 | 설명 |
|---|---|---|
| `PORT` | | 서버 포트 (기본 3000) |
| `MONGODB_URI` | ✅ | MongoDB 접속 문자열 |
| `MONGODB_DB` | | 접속 문자열의 DB 이름 대신 쓸 이름 (보통 비워 둠) |
| `MONGODB_POOL_MAX` | | 커넥션 풀 최대 크기 (기본 50) |
| `JWT_SECRET` | ✅ | 긴 무작위 문자열. 바꾸면 발급된 토큰이 모두 무효가 됩니다. |
| `JWT_EXPIRES_IN` | | 토큰 유효 기간 (기본 `7d`) |
| `CORS_ORIGIN` | | 프론트 주소 (기본 `http://localhost:5173`). 같은 도메인으로 서비스하면 쓰이지 않습니다. |
| `TRUST_PROXY` | | nginx 한 단 뒤에서 운영할 때 `1`. 속도 제한이 실제 클라이언트 IP를 보게 합니다. |
| `REDIS_URL` | | 서버를 2대 이상 띄울 때 **필수**. 소켓 이벤트 전달과 속도 제한 카운터를 공유합니다. |
| `TOSS_CLIENT_KEY` | | 토스 결제위젯 클라이언트 키 (`test_gck_…` / `live_gck_…`) |
| `TOSS_SECRET_KEY` | | 토스 시크릿 키 (`test_gsk_…` / `live_gsk_…`). **서버에만** 둡니다. |
| `PAYMENT_MOCK` | | `false`면 개발 환경에서도 모의 결제를 끕니다. |
| `THROTTLE_DISABLED` | | `true`면 속도 제한을 끕니다. **테스트 전용**, 운영에서는 설정하지 않습니다. |
| `DISABLE_SCHEDULERS` | | `true`면 스케줄러를 끕니다. 다중 인스턴스에서 0번 외 인스턴스에 쓰이며 pm2 설정이 자동으로 지정합니다. |

`.env`는 `.gitignore`에 들어 있어 저장소에 올라가지 않습니다. 비밀값을 커밋하지 마세요.

---

## npm 스크립트

### backend

| 명령 | 설명 |
|---|---|
| `npm run start:dev` | 개발 서버 (watch) |
| `npm run build` / `npm run start:prod` | 빌드 / 빌드 결과 실행 (`node dist/main`) |
| `npm test` | 단위 테스트 (DB·Redis 불필요) |
| `npm run test:e2e` | 실제 MongoDB로 도는 E2E 테스트 |
| `npm run load-test` | 동시 입찰 부하 테스트 + 정합성 검증 (먼저 `npm run build`) |
| `npm run db:check` | DB 연결·쓰기 점검 |
| `npm run db:clean-temp` | 테스트가 비정상 종료돼 남은 임시 DB 정리 |
| `npm run admin:grant -- <이메일>` | 관리자 지정 (`admin:revoke`로 회수) |
| `npm run lint` / `npm run format` | oxlint / prettier |

그 외 점검용 스크립트: `backend/scripts/db-rtt.mjs`(DB 왕복 지연), `backend/scripts/db-throughput.mjs`(DB 초당 처리량)

### frontend

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 서버 (Vite) |
| `npm run build` | 타입 검사 + 프로덕션 빌드 (`frontend/dist`) |
| `npm run preview` | 빌드 결과 미리보기 |

---

## 테스트

```bash
cd backend
npm test                # 단위 테스트
npm run test:e2e        # 실제 MongoDB E2E (backend/.env 의 MONGODB_URI 필요)
npm run build && npm run load-test
```

- **단위 테스트**(`src/**/*.spec.ts`): 모의(mock) 모델로 서비스·가드·설정 로직을 검증합니다. 입찰 쿼리 표현식은 `mingo`로, 소켓은 실제 Socket.IO 연결로, Redis 로직은 `ioredis-mock`으로 확인합니다.
- **E2E 테스트**(`test/*.e2e-spec.ts`): 앱 전체를 띄우고 **임시 DB**(`bidverse_e2e_*`)를 만들어 실제 HTTP·WebSocket으로 시나리오를 돌린 뒤 DB를 지웁니다. 토스 결제는 토스 API 모양의 **가짜 서버**(`test/fake-toss.ts`)로 검증하므로 실제 키가 필요 없습니다.
- **부하 테스트**(`scripts/load-test.mjs`): 임시 DB로 서버를 직접 띄워 수백 명이 동시에 입찰하게 한 뒤, **정합성 불변식**(가격 역전·중복·누락 없음, 알림·주문 개수 일치 등)을 DB에서 직접 검사합니다.

> E2E와 부하 테스트는 `MONGODB_URI`가 가리키는 클러스터에 임시 DB를 만듭니다. 기존 DB(`bidverse` 등)는 건드리지 않으며, 지우는 대상은 `bidverse_e2e_`·`bidverse_load_`·`bidverse_check_` 접두사로 시작하는 DB뿐입니다.

---

## 결제(토스페이먼츠) 설정

1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com)에서 **결제위젯 연동 키**를 확인합니다.
   - 클라이언트 키 `test_gck_…` / 시크릿 키 `test_gsk_…` 를 한 쌍으로 사용합니다. (`test_`끼리, `live_`끼리)
2. `backend/.env`에 `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`를 넣고 백엔드를 재시작합니다.
3. 개발자센터에 **웹훅 URL**을 등록합니다: `https://<도메인>/api/payments/webhook`
   (가상계좌 입금 완료, 외부 취소 같은 상태 변화를 받습니다.)

| 상황 | 동작 |
|---|---|
| 키 두 개 모두 있음 | 실제 토스 결제 |
| 키 없음 + 개발 환경 | **모의 결제** (결제 화면에서 "모의 결제 승인" 버튼, 실제 결제 없음) |
| 키 없음 + 운영(`NODE_ENV=production`) | **결제 차단** (모의 결제로 공짜 결제 완료가 되는 사고 방지) |

결제 흐름의 안전장치는 [CODEME.md](./CODEME.md#결제-paymentsservice)에 설명되어 있습니다.

---

## 배포 (nginx + pm2, AWS EC2 Ubuntu)

운영은 **nginx가 정적 파일(`frontend/dist`)과 리버스 프록시를 맡고, pm2가 NestJS를 실행**하는 구성을 기준으로 합니다.
설정 파일은 이미 들어 있습니다.

- [`ecosystem.config.cjs`](./ecosystem.config.cjs) — pm2 설정 (배포 순서가 파일 맨 위 주석에 있습니다)
- [`deploy/nginx/bidverse.conf`](./deploy/nginx/bidverse.conf) — nginx 설정 (설치·HTTPS 방법이 주석에 있습니다)

```bash
# 서버에서 (프로젝트 루트 = /var/www/bidverse)
cd backend  && npm ci && npm run build
cd ../frontend && npm ci && npm run build
cd .. && pm2 start ecosystem.config.cjs      # 최초 1회
pm2 reload ecosystem.config.cjs              # 이후 배포 (무중단 재시작)
pm2 save && pm2 startup                      # 재부팅 시 자동 시작
```

체크리스트
- `backend/.env`에 `MONGODB_URI`, `JWT_SECRET`, (결제 사용 시) 토스 키를 넣었는지
- nginx `server_name`과 `root` 경로를 실제 값으로 바꿨는지
- EC2 보안 그룹은 **80/443만** 열고 백엔드 포트(3000)는 외부에 열지 않았는지
- HTTPS: `sudo certbot --nginx -d <도메인>`
- 토스 개발자센터에 웹훅 URL을 등록했는지

**인스턴스를 늘리려면** (`backend/.env`에 `REDIS_URL` 필수):

```bash
API_INSTANCES=3 pm2 start ecosystem.config.cjs   # 포트 3000, 3001, 3002 로 3개
```

nginx upstream에 같은 포트를 나열하세요. Redis 없이 2개 이상 띄우려 하면 pm2 설정이 에러로 막습니다.
(Redis 없이는 한 인스턴스의 입찰이 다른 인스턴스에 붙은 구경꾼에게 전달되지 않기 때문입니다.)

---

## 개발할 때 알아둘 점

- **`start:dev`가 떠 있을 때 `npm run build`를 돌리지 마세요.** 빌드가 watch 모드가 쓰는 `dist` 폴더를 지워서 서버가 죽습니다. 타입 확인만 필요하면 `npx tsc --noEmit -p tsconfig.build.json`을 쓰세요.
- **ESM 프로젝트입니다.** 백엔드 소스에서 상대 경로 import는 `./foo.js`처럼 **`.js` 확장자**를 붙입니다.
- **Mongoose 스키마의 참조 ID는 `Schema.Types.ObjectId`로 선언**해야 합니다. `Types.ObjectId`를 type으로 쓰면 필드가 `Mixed`로 잡혀 캐스팅이 조용히 깨집니다. (회귀 방지 테스트 `src/schemas.spec.ts`가 있습니다.)
- **인증 정보는 5초 캐시**됩니다. 같은 서버에서 정지·권한 변경을 하면 즉시, 다른 서버에서는 최대 5초 뒤에 반영됩니다. DB를 직접 고쳤다면 최대 5초 뒤에 적용됩니다.
- **로컬 DB는 `.env`의 `MONGODB_URI` 그대로** 씁니다. 테스트처럼 임시 DB로 돌리고 싶다면 `MONGODB_DB`를 지정하세요.
- 서버가 여러 대일 때 Socket.IO는 **websocket 전용**으로 연결합니다. (기본값인 long-polling은 요청마다 다른 서버로 갈 수 있어서 sticky session이 필요해집니다.)

---

## 현재 상태와 한계

솔직하게 정리합니다.

- ✅ 단위 테스트(157개), 실제 MongoDB E2E(50개), 부하 테스트(정합성 23개 항목) 통과
- ✅ 브라우저에서 입찰·채팅·모의 결제·환불·관리자 화면 동작 확인
- ⚠️ **실제 토스 키로 결제위젯을 띄워 끝까지 결제하는 것은 아직 검증하지 못했습니다.** 결제 승인/취소/웹훅 로직은 토스 API를 흉내 낸 가짜 서버로 검증했습니다. 운영 전에 테스트 키로 한 번 결제해 보세요.
- ⚠️ **Redis는 실제 서버로 검증하지 못했습니다.** `ioredis-mock`으로 인스턴스 간 이벤트 전달과 속도 제한 카운터 로직을 검증했습니다.
- ⚠️ 부하 테스트는 Atlas 무료 티어(초당 약 100 ops 제한)에서 돌렸습니다. 정합성은 확인했지만 **서버 자체의 최대 처리량은 측정하지 못했습니다.** 로컬 MongoDB나 유료 티어에서 같은 스크립트를 돌리면 됩니다.
- 이미지는 **URL 입력 방식**입니다. 파일 업로드는 없습니다.
- 채팅에는 **닉네임이 그대로 표시**됩니다. (입찰 내역은 `a***`처럼 가립니다.) 채팅 닉네임으로 입찰자를 추측할 수 있는 점에 유의하세요.
- 채팅에 욕설 필터는 없고, 도배 제한과 삭제 권한으로만 관리합니다.
- 결제 미완료 주문의 자동 취소(기한 만료)는 아직 없습니다.

---

## 폴더 구조

```
bidverse/
├─ backend/              NestJS API 서버
│  ├─ src/               소스 (모듈별 폴더) — 자세한 설명은 CODEME.md
│  ├─ test/              E2E 테스트, 가짜 토스 서버, 테스트 헬퍼
│  ├─ scripts/           관리자 지정, DB 점검, 부하 테스트 등 CLI
│  └─ .env.example       환경변수 예시
├─ frontend/             React 웹 앱 (Vite)
│  └─ src/               페이지, 컴포넌트, 디자인 시스템(index.css)
├─ deploy/nginx/         nginx 설정
├─ ecosystem.config.cjs  pm2 설정
├─ README.md             지금 보는 문서
├─ CODEME.md             코드 안내 문서
└─ LICENSE
```

---

## 라이선스

[Mozilla Public License 2.0](./LICENSE)
