/**
 * pm2 설정 — EC2 Ubuntu 기준.
 *
 * 배포 순서 (서버에서, 프로젝트 루트 = /var/www/bidverse):
 *   cd backend  && npm ci && npm run build
 *   cd ../frontend && npm ci && npm run build      # nginx가 frontend/dist를 정적으로 서빙
 *   cd .. && pm2 start ecosystem.config.cjs        # 최초 1회
 *   pm2 reload ecosystem.config.cjs                # 이후 배포 때 (무중단 재시작)
 *   pm2 save && pm2 startup                        # 재부팅 시 자동 시작
 *
 * 비밀값(JWT_SECRET, MONGODB_URI, TOSS_SECRET_KEY 등)은 backend/.env 에 둔다. 백엔드는 cwd 기준으로
 * .env를 읽으므로 아래 cwd를 backend 로 맞춰 뒀다. 이 파일에는 비밀값을 넣지 말 것.
 *
 * ── 인스턴스 수 ────────────────────────────────────────────────────────────────
 * 기본은 1개다. 늘리려면 먼저 backend/.env 에 REDIS_URL 을 설정하고:
 *
 *   API_INSTANCES=3 pm2 start ecosystem.config.cjs
 *
 * 인스턴스마다 별도 프로세스를 다른 포트(3000, 3001, 3002 ...)로 띄운다. pm2 cluster 모드(포트 공유)
 * 대신 이렇게 하는 이유: ESM 빌드와의 호환 문제를 피하고, nginx upstream에서 인스턴스를 직접 제어하기
 * 위해서다. deploy/nginx/bidverse.conf 의 upstream 에 같은 포트들을 나열해야 한다.
 *
 * Redis가 하는 일: ① Socket.IO 이벤트를 인스턴스 간에 전달(입찰이 A에서 처리돼도 B에 붙은 구경꾼이 받음),
 * ② 속도 제한 카운터를 공유. 정산/종료 임박 스케줄러는 DB에서 원자적으로 선점하므로 여러 인스턴스가
 * 돌려도 안전하지만, 불필요한 중복 조회를 줄이려고 0번 인스턴스에서만 켠다.
 */
const fs = require('fs');
const path = require('path');

const instances = Math.max(1, Number(process.env.API_INSTANCES) || 1);
const basePort = Number(process.env.API_BASE_PORT) || 3000;
const backendDir = path.join(__dirname, 'backend');

/** backend/.env 또는 환경변수에 REDIS_URL 이 있는지 (값은 읽지 않고 존재만 확인) */
function hasRedisUrl() {
  if (process.env.REDIS_URL) return true;
  try {
    return /^\s*REDIS_URL\s*=\s*\S+/m.test(fs.readFileSync(path.join(backendDir, '.env'), 'utf8'));
  } catch {
    return false;
  }
}

if (instances > 1 && !hasRedisUrl()) {
  throw new Error(
    `API_INSTANCES=${instances} 인데 REDIS_URL 이 설정되어 있지 않음. ` +
      'Redis 없이 여러 인스턴스를 띄우면 실시간 입찰이 인스턴스 사이에 전달되지 않는다. ' +
      'backend/.env 에 REDIS_URL 을 추가하거나 API_INSTANCES 를 1로 두자.',
  );
}

module.exports = {
  apps: Array.from({ length: instances }, (_, i) => ({
    name: instances === 1 ? 'bidverse-api' : `bidverse-api-${i}`,
    cwd: backendDir,
    script: 'dist/main.js',
    exec_mode: 'fork',
    instances: 1,

    env: {
      NODE_ENV: 'production',
      PORT: basePort + i,
      // nginx 한 단을 거치므로 X-Forwarded-For 의 클라이언트 IP를 신뢰한다 (속도 제한이 IP 기준).
      TRUST_PROXY: '1',
      // 스케줄러는 0번 인스턴스에서만 (위 설명 참고)
      DISABLE_SCHEDULERS: i === 0 ? 'false' : 'true',
      // 프론트와 API가 같은 도메인(nginx)으로 나가면 CORS는 쓰이지 않는다.
      // 다른 도메인에서 호출한다면 backend/.env 의 CORS_ORIGIN 으로 지정.
    },

    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '512M',
    // reload/stop 때 SIGINT 이후 정리(DB 연결 종료, 스케줄러 중지)할 시간
    kill_timeout: 10000,

    time: true,
    merge_logs: true,
    out_file: path.join(__dirname, 'logs', `api-${i}.out.log`),
    error_file: path.join(__dirname, 'logs', `api-${i}.err.log`),
  })),
};
