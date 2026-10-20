import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.js';

/** 테스트가 만든 임시 DB 이름. 이 접두사가 아니면 절대 지우지 않는다. */
export const TEMP_DB_PREFIX = 'bidverse_e2e_';

export interface TestApp {
  app: INestApplication;
  url: string;
  dbName: string;
  get: <T>(token: unknown) => T;
  connection: Connection;
  request: <T = any>(method: string, path: string, opts?: ReqOpts) => Promise<{ status: number; body: T }>;
  register: (nickname: string) => Promise<{ id: string; token: string; email: string; nickname: string }>;
  connectSocket: (token?: string) => Promise<Socket>;
  close: () => Promise<void>;
}

interface ReqOpts {
  token?: string;
  body?: unknown;
}

/**
 * 실제 MongoDB(MONGODB_URI)에 임시 DB를 만들어 앱 전체를 띄운다.
 * 스케줄러(정산/종료 임박)는 끄고, 테스트가 `sweep()`을 직접 호출해 시점을 통제한다.
 */
export async function startApp(extraEnv: Record<string, string> = {}): Promise<TestApp> {
  const dbName = `${TEMP_DB_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  process.env.MONGODB_DB = dbName;
  process.env.DISABLE_SCHEDULERS = 'true';
  process.env.THROTTLE_DISABLED = 'true';
  // 결제: 기본은 키 없는 모의 모드. 필요한 테스트가 토스 키/가짜 서버 주소를 넘긴다.
  for (const key of ['TOSS_CLIENT_KEY', 'TOSS_SECRET_KEY', 'TOSS_API_BASE', 'PAYMENT_MOCK']) delete process.env[key];
  Object.assign(process.env, extraEnv);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0);
  const url = (await app.getUrl()).replace('[::1]', 'localhost');
  const connection = app.get<Connection>(getConnectionToken());
  // 인덱스(유니크 제약 등)가 실제로 만들어진 뒤부터 테스트가 돌도록 기다린다.
  await Promise.all(Object.values(connection.models).map((m) => m.init()));

  const sockets: Socket[] = [];
  let seq = 0;

  const request: TestApp['request'] = async (method, path, opts = {}) => {
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // JSON이 아니면 원문 그대로 돌려준다.
    }
    return { status: res.status, body };
  };

  return {
    app,
    url,
    dbName,
    get: (token) => app.get(token as never),
    connection,
    request,
    register: async (nickname) => {
      const email = `${nickname.toLowerCase()}-${++seq}-${Date.now()}@example.com`;
      const res = await request('POST', '/auth/register', {
        body: { email, password: 'password123', nickname },
      });
      if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
      return { id: res.body.user.id, token: res.body.accessToken, email, nickname };
    },
    connectSocket: async (token) => {
      const socket = io(url, { auth: { token }, transports: ['websocket'], forceNew: true });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      return socket;
    },
    close: async () => {
      sockets.forEach((s) => s.disconnect());
      if (dbName.startsWith(TEMP_DB_PREFIX)) await connection.dropDatabase();
      await app.close();
    },
  };
}

/** 소켓 이벤트를 모아 두었다가 필요한 때 꺼내 쓴다. */
export function collect<T = any>(socket: Socket, event: string) {
  const events: T[] = [];
  socket.on(event, (e: T) => events.push(e));
  return {
    events,
    /** n개가 모일 때까지 기다린다. */
    waitFor: async (n = 1, timeoutMs = 3000) => {
      const start = Date.now();
      while (events.length < n) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`'${event}' 이벤트 ${n}개를 기다렸지만 ${events.length}개만 도착함`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return events;
    },
  };
}

export const joinAuction = (socket: Socket, auctionId: string) =>
  socket.emitWithAck('auction:join', { auctionId }) as Promise<{ ok: boolean; serverTime?: number }>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
