import { describe, it, expect, beforeEach } from 'vitest';
import { MessengerChatService, MessengerChatError } from './chat.service';
import { InMemoryFileStorage } from '../lib/file-storage';

// Фейк-prisma для изолированной переписки мессенджера.
function makePrisma() {
  const users = new Map<string, any>([
    ['a', { id: 'a', organizationId: 'o', messengerId: 'AAAA1111', displayName: 'Анна', isActive: true, registeredAt: new Date() }],
    ['b', { id: 'b', organizationId: 'o', messengerId: 'BBBB2222', displayName: 'Борис', isActive: true, registeredAt: new Date() }],
    ['c', { id: 'c', organizationId: 'o', messengerId: 'CCCC3333', displayName: 'Век', isActive: true, registeredAt: null }], // не зарегистрирован
  ]);
  const convs = new Map<string, any>();
  const parts: any[] = [];
  const msgs: any[] = [];
  let seq = 0;

  const match = (val: any, cond: any): boolean => {
    if (cond === undefined) return true;
    if (cond && typeof cond === 'object') {
      if ('not' in cond) return val !== cond.not && (cond.not !== null ? true : val !== null);
      if ('gt' in cond) return val && val > cond.gt;
      if ('in' in cond) return cond.in.includes(val);
      if ('contains' in cond) return String(val ?? '').toLowerCase().includes(String(cond.contains).toLowerCase());
    }
    return val === cond;
  };

  return {
    _users: users, _convs: convs, _parts: parts, _msgs: msgs,
    messengerUser: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
      findMany: async ({ where, take }: any) => {
        let r = [...users.values()].filter(
          (u) =>
            match(u.organizationId, where.organizationId) &&
            match(u.isActive, where.isActive) &&
            (where.registeredAt ? u.registeredAt !== null : true) &&
            match(u.id, where.id) &&
            (where.OR ? where.OR.some((o: any) =>
              (o.displayName && match(u.displayName, o.displayName)) ||
              (o.messengerId && match(u.messengerId, o.messengerId))) : true),
        );
        return take ? r.slice(0, take) : r;
      },
      update: async ({ where, data }: any) => {
        const u = users.get(where.id);
        if (u) Object.assign(u, data);
        return u;
      },
    },
    messengerParticipant: {
      findUnique: async ({ where }: any) => {
        const k = where.conversationId_messengerUserId;
        return parts.find((p) => p.conversationId === k.conversationId && p.messengerUserId === k.messengerUserId) ?? null;
      },
      findMany: async ({ where }: any) =>
        parts.filter((p) =>
          (where.messengerUserId ? p.messengerUserId === where.messengerUserId : true) &&
          (where.conversationId ? p.conversationId === where.conversationId : true)),
      update: async ({ where, data }: any) => {
        const k = where.conversationId_messengerUserId;
        const p = parts.find((x) => x.conversationId === k.conversationId && x.messengerUserId === k.messengerUserId);
        Object.assign(p, data);
        return p;
      },
      upsert: async ({ where, create }: any) => {
        const k = where.conversationId_messengerUserId;
        let p = parts.find((x) => x.conversationId === k.conversationId && x.messengerUserId === k.messengerUserId);
        if (!p) { p = { conversationId: k.conversationId, messengerUserId: k.messengerUserId, lastReadAt: null, ...create }; parts.push(p); }
        return p;
      },
    },
    messengerConversation: {
      findFirst: async ({ where }: any) =>
        [...convs.values()].find((c) => c.id === where.id && c.organizationId === where.organizationId) ?? null,
      create: async ({ data }: any) => {
        const id = `conv${++seq}`;
        const conv = { id, organizationId: data.organizationId, isGroup: !!data.isGroup, title: data.title ?? null, updatedAt: new Date() };
        convs.set(id, conv);
        for (const p of data.participants.create) parts.push({ conversationId: id, messengerUserId: p.messengerUserId, lastReadAt: null });
        return conv;
      },
      update: async ({ where, data }: any) => {
        const c = convs.get(where.id);
        Object.assign(c, data);
        return c;
      },
      findMany: async ({ where }: any) => {
        return [...convs.values()]
          .filter((c) => where.id.in.includes(c.id) && c.organizationId === where.organizationId)
          .map((c) => ({
            ...c,
            participants: parts
              .filter((p) => p.conversationId === c.id)
              .map((p) => ({ ...p, messengerUser: users.get(p.messengerUserId) })),
            messages: msgs.filter((m) => m.conversationId === c.id).sort((x, y) => y.createdAt - x.createdAt).slice(0, 1),
          }));
      },
    },
    messengerMessage: {
      create: async ({ data }: any) => {
        const m = { id: `m${++seq}`, ...data, createdAt: new Date() };
        msgs.push(m);
        return m;
      },
      findMany: async ({ where, skip = 0, take = 50 }: any) =>
        msgs.filter((m) => m.conversationId === where.conversationId)
          .sort((x, y) => y.createdAt - x.createdAt).slice(skip, skip + take),
      count: async ({ where }: any) =>
        msgs.filter((m) =>
          m.conversationId === where.conversationId &&
          match(m.senderId, where.senderId) &&
          (where.createdAt ? m.createdAt > where.createdAt.gt : true)).length,
    },
  } as any;
}

describe('MessengerChatService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: MessengerChatService;
  const A = { userId: 'a', orgId: 'o' };

  beforeEach(() => {
    prisma = makePrisma();
    svc = new MessengerChatService(prisma);
  });

  it('searchContacts: только зарегистрированные, кроме себя; поиск по имени', async () => {
    const all = await svc.searchContacts(A, '');
    expect(all.map((u) => u.id).sort()).toEqual(['b']); // c не зарегистрирован, a — это сам
    const byName = await svc.searchContacts(A, 'бор');
    expect(byName).toHaveLength(1);
    expect(byName[0].name).toBe('Борис');
  });

  it('createConversation дедуплицирует 1-на-1', async () => {
    const c1 = await svc.createConversation(A, 'b');
    expect(c1.existed).toBe(false);
    const c2 = await svc.createConversation(A, 'b');
    expect(c2.existed).toBe(true);
    expect(c2.id).toBe(c1.id);
  });

  it('нельзя начать диалог с собой', async () => {
    await expect(svc.createConversation(A, 'a')).rejects.toBeInstanceOf(MessengerChatError);
  });

  it('send/list сообщений; не-участник получает 404', async () => {
    const conv = await svc.createConversation(A, 'b');
    await svc.sendMessage(A, conv.id, 'привет');
    const msgs = await svc.listMessages(A, conv.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('привет');
    // 'c' не участник
    await expect(svc.listMessages({ userId: 'c', orgId: 'o' }, conv.id)).rejects.toMatchObject({ name: 'NotFound' });
  });

  it('listConversations считает непрочитанные и помечает прочитанным', async () => {
    const conv = await svc.createConversation(A, 'b');
    await svc.sendMessage({ userId: 'b', orgId: 'o' }, conv.id, 'эй');
    let list = await svc.listConversations(A);
    expect(list[0].unread).toBe(1);
    await svc.markRead(A, conv.id);
    list = await svc.listConversations(A);
    expect(list[0].unread).toBe(0);
  });

  it('E2E: setPublicKey сохраняет ключ, контакты его отдают', async () => {
    await svc.setPublicKey({ userId: 'b', orgId: 'o' }, 'PUBKEY_B');
    const contacts = await svc.searchContacts(A, '');
    expect(contacts.find((u) => u.id === 'b')?.publicKey).toBe('PUBKEY_B');
  });

  it('группа: создание с названием и участниками, видна как group', async () => {
    const g = await svc.createGroup(A, 'Склад №1', ['b', 'c']);
    expect(g.id).toBeTruthy();
    const convs = await svc.listConversations(A);
    const grp = convs.find((c) => c.id === g.id);
    expect(grp?.isGroup).toBe(true);
    expect(grp?.title).toBe('Склад №1');
    // участники (без себя) — b и c
    expect(grp?.participants.map((p) => p.id).sort()).toEqual(['b', 'c']);
  });

  it('группа: без участников (только сам) — ошибка', async () => {
    await expect(svc.createGroup(A, 'Пусто', ['a'])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('группа: addMember добавляет участника; в 1-на-1 нельзя', async () => {
    const g = await svc.createGroup(A, 'Группа', ['b']);
    await svc.addMember(A, g.id, 'c');
    const convs = await svc.listConversations(A);
    expect(convs.find((c) => c.id === g.id)?.participants.map((p) => p.id).sort()).toEqual(['b', 'c']);
    // в 1-на-1 добавлять нельзя
    const direct = await svc.createConversation(A, 'b');
    await expect(svc.addMember(A, direct.id, 'c')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('вложение: загрузка участником, скачивание участником, чужой — 404', async () => {
    const s = new MessengerChatService(prisma, new InMemoryFileStorage());
    const conv = await s.createConversation(A, 'b');
    const up = await s.uploadAttachment(A, conv.id, Buffer.from('data'), 'image/png', 'pic.png');
    expect(up.key).toMatch(/^messenger\//);
    const dl = await s.downloadAttachment({ userId: 'b', orgId: 'o' }, up.key);
    expect(dl.buffer.toString()).toBe('data');
    await expect(
      s.downloadAttachment({ userId: 'c', orgId: 'o' }, up.key),
    ).rejects.toMatchObject({ name: 'NotFound' });
  });
});
