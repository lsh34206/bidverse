import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { User } from './user.schema.js';
import { UsersService } from './users.service.js';

const exec = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('UsersService 인증 캐시', () => {
  let service: UsersService;
  const model = { findById: vi.fn(), findByIdAndUpdate: vi.fn() };
  const id = new Types.ObjectId().toString();
  const doc = (over: Record<string, unknown> = {}) => ({
    id,
    role: 'buyer',
    status: 'active',
    nickname: 'nick',
    ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const module = await Test.createTestingModule({
      providers: [UsersService, { provide: getModelToken(User.name), useValue: model }],
    }).compile();
    service = module.get(UsersService);
  });

  afterEach(() => vi.useRealTimers());

  it('짧은 시간 안의 반복 조회는 DB를 한 번만 읽는다', async () => {
    model.findById.mockReturnValue(exec(doc()));
    expect(await service.getAuthSnapshot(id)).toEqual({ id, role: 'buyer', status: 'active', nickname: 'nick' });
    await service.getAuthSnapshot(id);
    await service.getAuthSnapshot(id);
    expect(model.findById).toHaveBeenCalledTimes(1);
  });

  it('TTL(5초)이 지나면 다시 읽어서 바뀐 상태(정지 등)를 반영한다', async () => {
    model.findById.mockReturnValueOnce(exec(doc())).mockReturnValueOnce(exec(doc({ status: 'banned' })));
    expect((await service.getAuthSnapshot(id))?.status).toBe('active');
    vi.advanceTimersByTime(4_000);
    expect((await service.getAuthSnapshot(id))?.status).toBe('active'); // 아직 캐시
    vi.advanceTimersByTime(1_500);
    expect((await service.getAuthSnapshot(id))?.status).toBe('banned');
    expect(model.findById).toHaveBeenCalledTimes(2);
  });

  it('같은 인스턴스에서 정지/권한 변경을 하면 캐시가 바로 무효화된다', async () => {
    model.findById.mockReturnValueOnce(exec(doc())).mockReturnValueOnce(exec(doc({ status: 'banned' })));
    await service.getAuthSnapshot(id);
    model.findByIdAndUpdate.mockReturnValue(exec(doc({ status: 'banned' })));
    await service.updateById(id, { status: 'banned' });
    expect((await service.getAuthSnapshot(id))?.status).toBe('banned');
  });

  it('없는 사용자는 캐시하지 않고, 잘못된 id는 DB를 읽지 않는다', async () => {
    model.findById.mockReturnValue(exec(null));
    expect(await service.getAuthSnapshot(id)).toBeNull();
    expect(await service.getAuthSnapshot(id)).toBeNull();
    expect(model.findById).toHaveBeenCalledTimes(2);

    model.findById.mockClear();
    expect(await service.getAuthSnapshot('not-an-id')).toBeNull();
    expect(model.findById).not.toHaveBeenCalled();
  });
});
