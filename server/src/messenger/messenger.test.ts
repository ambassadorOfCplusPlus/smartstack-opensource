import { describe, it, expect, beforeEach } from 'vitest';
import { MessengerService, MessengerError } from './service';

// Фейк-prisma: in-memory реестр организации и пользователей мессенджера.
function makePrisma() {
  const org = { id: 'org1', messengerUserLimit: 2 };
  const mu = new Map<string, any>();
  let seq = 0;
  return {
    _org: org,
    _mu: mu,
    organization: {
      findUnique: async ({ where }: any) => (where.id === org.id ? { ...org } : null),
      update: async ({ where, data }: any) => {
        if (where.id === org.id && typeof data.messengerUserLimit === 'number')
          org.messengerUserLimit = data.messengerUserLimit;
        return { ...org };
      },
    },
    messengerUser: {
      count: async ({ where }: any) =>
        [...mu.values()].filter((u) => u.organizationId === where.organizationId).length,
      findMany: async ({ where }: any) =>
        [...mu.values()].filter((u) => u.organizationId === where.organizationId),
      findUnique: async ({ where }: any) => {
        if (where.id) return mu.get(where.id) ?? null;
        if (where.messengerId)
          return [...mu.values()].find((u) => u.messengerId === where.messengerId) ?? null;
        return null;
      },
      create: async ({ data }: any) => {
        const rec = {
          id: `mu${++seq}`,
          organizationId: data.organizationId,
          messengerId: data.messengerId,
          displayName: null,
          passwordHash: null,
          recoveryEmail: null,
          isActive: true,
          registeredAt: null,
          createdAt: new Date(),
        };
        mu.set(rec.id, rec);
        return rec;
      },
      update: async ({ where, data }: any) => {
        const r = mu.get(where.id);
        Object.assign(r, data);
        return r;
      },
      delete: async ({ where }: any) => {
        const r = mu.get(where.id);
        mu.delete(where.id);
        return r;
      },
    },
  } as any;
}

describe('MessengerService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: MessengerService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new MessengerService(prisma);
  });

  it('создаёт аккаунт с уникальным messengerId и считает занятость', async () => {
    const a = await svc.create('org1');
    expect(a.messengerId).toMatch(/^[A-Z2-9]{8}$/);
    const cap = await svc.capacity('org1');
    expect(cap.used).toBe(1);
    expect(cap.free).toBe(1);
    expect(cap.estimate.forLimitMb).toBe(60 + 2 * 3);
  });

  it('не превышает лимит', async () => {
    await svc.create('org1');
    await svc.create('org1'); // лимит = 2
    await expect(svc.create('org1')).rejects.toMatchObject({ name: 'LimitReached' });
  });

  it('удаляет аккаунт только своей организации', async () => {
    const a = await svc.create('org1');
    await expect(svc.remove('orgX', a.id)).rejects.toBeInstanceOf(MessengerError);
    const ok = await svc.remove('org1', a.id);
    expect(ok.ok).toBe(true);
    expect((await svc.capacity('org1')).used).toBe(0);
  });

  it('нельзя задать лимит ниже занятого', async () => {
    await svc.create('org1');
    await svc.create('org1');
    await expect(svc.setLimit('org1', 1)).rejects.toMatchObject({ name: 'LimitBelowUsed' });
    const cap = await svc.setLimit('org1', 5);
    expect(cap.limit).toBe(5);
    expect(cap.free).toBe(3);
  });

  it('list помечает registered по registeredAt', async () => {
    const a = await svc.create('org1');
    let items = await svc.list('org1');
    expect(items[0].registered).toBe(false);
    prisma._mu.get(a.id).registeredAt = new Date();
    items = await svc.list('org1');
    expect(items[0].registered).toBe(true);
  });

  it('register активирует ключ, повторно — нельзя, неизвестный — 404', async () => {
    const a = await svc.create('org1');
    const r = await svc.register(a.messengerId, 'Иван', 'secret123');
    expect(r.displayName).toBe('Иван');
    expect(prisma._mu.get(a.id).registeredAt).not.toBeNull();
    await expect(svc.register(a.messengerId, 'Иван', 'secret123')).rejects.toMatchObject({
      name: 'AlreadyRegistered',
    });
    await expect(svc.register('NOPE0000', 'X', 'secret123')).rejects.toMatchObject({
      name: 'NotFound',
    });
  });

  it('login проверяет пароль; до регистрации и при неверном — 401', async () => {
    const a = await svc.create('org1');
    await expect(svc.login(a.messengerId, 'secret123')).rejects.toMatchObject({
      name: 'BadCredentials',
    }); // ещё не зарегистрирован
    await svc.register(a.messengerId, 'Иван', 'secret123', 'i@x.io');
    const u = await svc.login(a.messengerId, 'secret123');
    expect(u.id).toBe(a.id);
    expect(u.displayName).toBe('Иван');
    await expect(svc.login(a.messengerId, 'wrong')).rejects.toMatchObject({
      name: 'BadCredentials',
    });
  });
});
