import { describe, it, expect } from 'vitest';
import { generateKey } from './codec';
import { applyBatch, InMemoryDedupStore, optype, type ISyncApplier, type ApplyOutcome } from './engine';
import { HttpRelayClient, relayhttp, type FetchLike, type RelayConfig } from './relay';
import { pushBatch, pullApply } from './orchestrator';
import type { SyncOp } from './codec';

// ── Фейк-транспорт: модель append-only бокса реле поверх FetchLike ────────────
// Хранит записи {id,ts,device,ct,kind}; POST добавляет, GET ?since= отдаёт
// ts >= since (append-only журнал, курсор по ts). Без сети.
function makeFakeRelay(cfg: RelayConfig): { fetch: FetchLike; entries: RawEntry[]; requireAuth: string } {
  interface RawEntryLocal {
    id: number;
    ts: number;
    device: string;
    ct: string;
    kind: string;
  }
  const store: RawEntryLocal[] = [];
  let nextId = 1;
  const token = cfg.token;

  const fetch: FetchLike = async (url, init) => {
    const auth = init?.headers?.['Authorization'];
    if (auth !== `Bearer ${token}`) {
      return jsonResp(401, { error: 'unauthorized' });
    }
    const method = init?.method ?? 'GET';
    const boxPrefix = `${cfg.baseUrl}/v1/box/${encodeURIComponent(cfg.boxId)}`;
    if (method === 'POST' && url === boxPrefix) {
      const body = JSON.parse(init!.body!);
      const e: RawEntryLocal = {
        id: nextId++,
        ts: body.ts,
        device: body.device,
        ct: body.ct,
        kind: body.kind ?? '',
      };
      store.push(e);
      return jsonResp(200, { id: e.id });
    }
    if (method === 'GET' && url.startsWith(`${boxPrefix}?`)) {
      const qs = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      const since = Number(qs.get('since') ?? '0');
      const limit = Number(qs.get('limit') ?? '100');
      const rows = store
        .filter((e) => e.ts >= since)
        .sort((a, b) => a.ts - b.ts || a.id - b.id)
        .slice(0, limit)
        .map((e) => ({ id: e.id, ts: e.ts, device: e.device, ct: e.ct, kind: e.kind }));
      return jsonResp(200, { entries: rows });
    }
    return jsonResp(404, { error: 'not found' });
  };

  return { fetch, entries: store as unknown as RawEntry[], requireAuth: token };
}

interface RawEntry {
  id: number;
  ts: number;
  device: string;
  ct: string;
  kind: string;
}

function jsonResp(status: number, obj: unknown) {
  const text = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// Прикладной слой, копящий проведённые операции.
class RecordingApplier implements ISyncApplier {
  applied: Array<{ type: string; opId: string; data: unknown }> = [];
  private ok(type: string, opId: string, data: unknown): ApplyOutcome {
    this.applied.push({ type, opId, data });
    return { ok: true };
  }
  receive(opId: string, data: unknown) {
    return this.ok('receive', opId, data);
  }
  writeoff(opId: string, data: unknown) {
    return this.ok('writeoff', opId, data);
  }
  inventoryCount(opId: string, data: unknown) {
    return this.ok('inventory_count', opId, data);
  }
  priceChange(opId: string, data: unknown) {
    return this.ok('price_change', opId, data);
  }
  createProduct(opId: string, data: unknown) {
    return this.ok('create_product', opId, data);
  }
}

const cfg: RelayConfig = { baseUrl: 'http://relay.test:8787', token: 'secret-token', boxId: 'box42' };

function op(opId: string, device: string, type = optype.receive): SyncOp {
  return { opId, type, device, ts: 0, data: { note: opId } };
}

describe('orchestrator: push → pull по ts-курсору через фейк-транспорт', () => {
  it('устройство B получает и применяет операции устройства A', async () => {
    const key = generateKey();
    const { fetch } = makeFakeRelay(cfg);
    const relay = new HttpRelayClient(cfg, fetch);

    // A пушит два кадра с растущим ts.
    await pushBatch(relay, key, 'A', [op('op_a1', 'A')], 1000);
    await pushBatch(relay, key, 'A', [op('op_a2', 'A')], 2000);

    // B тянет с курсора 0.
    const applier = new RecordingApplier();
    const dedup = new InMemoryDedupStore();
    const r = await pullApply(relay, key, applier, dedup, 0, 100, 'B');

    expect(r.total).toBe(2);
    expect(r.applied).toBe(2);
    expect(applier.applied.map((a) => a.opId)).toEqual(['op_a1', 'op_a2']);
    // Курсор сдвинулся за максимальный ts (+1 мс).
    expect(r.cursor).toBe(2001);
  });

  it('повторный pull по сдвинутому курсору не отдаёт уже виденное', async () => {
    const key = generateKey();
    const { fetch } = makeFakeRelay(cfg);
    const relay = new HttpRelayClient(cfg, fetch);
    const applier = new RecordingApplier();
    const dedup = new InMemoryDedupStore();

    await pushBatch(relay, key, 'A', [op('op_1', 'A')], 1000);
    const first = await pullApply(relay, key, applier, dedup, 0, 100, 'B');
    expect(first.applied).toBe(1);

    // Новая операция после первого pull.
    await pushBatch(relay, key, 'A', [op('op_2', 'A')], 3000);
    const second = await pullApply(relay, key, applier, dedup, first.cursor, 100, 'B');
    expect(second.total).toBe(1);
    expect(second.applied).toBe(1);
    expect(applier.applied.map((a) => a.opId)).toEqual(['op_1', 'op_2']);
  });

  it('собственное эхо (selfDevice) пропускается', async () => {
    const key = generateKey();
    const { fetch } = makeFakeRelay(cfg);
    const relay = new HttpRelayClient(cfg, fetch);
    const applier = new RecordingApplier();
    const dedup = new InMemoryDedupStore();

    await pushBatch(relay, key, 'A', [op('mine', 'A')], 1000);
    // A тянет со своим selfDevice='A' — свой кадр не применяется.
    const r = await pullApply(relay, key, applier, dedup, 0, 100, 'A');
    expect(r.total).toBe(0);
    expect(applier.applied).toEqual([]);
    // Но курсор всё равно сдвигается за ts кадра (чтобы не застревать).
    expect(r.cursor).toBe(1001);
  });

  it('дубль между двумя pull не применяется дважды (дедуп по op_id)', async () => {
    const key = generateKey();
    const { fetch } = makeFakeRelay(cfg);
    const relay = new HttpRelayClient(cfg, fetch);
    const applier = new RecordingApplier();
    const dedup = new InMemoryDedupStore();

    await pushBatch(relay, key, 'A', [op('same', 'A')], 1000);
    const first = await pullApply(relay, key, applier, dedup, 0, 100, 'B');
    expect(first.applied).toBe(1);

    // Тот же op_id доставлен снова с бОльшим ts (ретрансляция).
    await pushBatch(relay, key, 'A', [op('same', 'A')], 5000);
    const second = await pullApply(relay, key, applier, dedup, first.cursor, 100, 'B');
    expect(second.total).toBe(1);
    expect(second.applied).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(applier.applied.length).toBe(1); // применено ровно раз
  });

  it('чужой кадр (неверный ключ) отклоняется, курсор всё равно двигается', async () => {
    const keyA = generateKey();
    const keyB = generateKey(); // B не знает ключ A
    const { fetch } = makeFakeRelay(cfg);
    const relay = new HttpRelayClient(cfg, fetch);

    await pushBatch(relay, keyA, 'A', [op('x', 'A')], 1000);
    const applier = new RecordingApplier();
    const r = await pullApply(relay, keyB, applier, new InMemoryDedupStore(), 0, 100, 'B');
    expect(r.total).toBe(1);
    expect(r.applied).toBe(0);
    expect(r.rejected).toBe(1);
    expect(r.cursor).toBe(1001);
  });

  it('неверный Bearer-токен → append бросает ошибку', async () => {
    const key = generateKey();
    const { fetch } = makeFakeRelay(cfg);
    const badRelay = new HttpRelayClient({ ...cfg, token: 'wrong' }, fetch, { maxAttempts: 1 });
    await expect(pushBatch(badRelay, key, 'A', [op('x', 'A')], 1000)).rejects.toThrow();
  });
});

describe('relayhttp: чистые построители URL/тел и парсер', () => {
  it('appendUrl / pollUrl / appendBody', () => {
    expect(relayhttp.appendUrl(cfg)).toBe('http://relay.test:8787/v1/box/box42');
    expect(relayhttp.pollUrl(cfg, 1500, 50)).toBe('http://relay.test:8787/v1/box/box42?since=1500&limit=50');
    expect(JSON.parse(relayhttp.appendBody(1000, 'A', 'CT'))).toEqual({ ts: 1000, device: 'A', ct: 'CT' });
    expect(JSON.parse(relayhttp.appendBody(1000, 'A', 'CT', 'snapshot'))).toEqual({
      ts: 1000,
      device: 'A',
      ct: 'CT',
      kind: 'snapshot',
    });
  });

  it('parsePoll разбирает entries и пропускает записи без ct', () => {
    const json = JSON.stringify({
      entries: [
        { id: 7, ts: 1000, device: 'A', ct: 'AAA', kind: '' },
        { id: 8, ts: 2000, device: 'B' }, // без ct → пропуск
        42, // мусор
      ],
    });
    const out = relayhttp.parsePoll(json);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({ ts: 1000, device: 'A', frameB64: 'AAA', name: '7', kind: '' });
  });

  it('нет массива entries → ошибка', () => {
    expect(() => relayhttp.parsePoll('{}')).toThrow(/entries/);
  });
});
