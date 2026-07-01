import { describe, it, expect } from 'vitest';
import {
  applyBatch,
  InMemoryDedupStore,
  optype,
  type ApplyOutcome,
  type ISyncApplier,
} from './engine';
import type { SyncOp } from './codec';

// Фейковый прикладной слой: считает вызовы по типу; writeoff можно заставить
// отклонять (недостаточно остатка).
class FakeApplier implements ISyncApplier {
  calls: string[] = [];
  rejectWriteoff = false;

  private ok(tag: string): ApplyOutcome {
    this.calls.push(tag);
    return { ok: true };
  }
  receive(opId: string): ApplyOutcome {
    return this.ok(`receive:${opId}`);
  }
  writeoff(opId: string): ApplyOutcome {
    this.calls.push(`writeoff:${opId}`);
    if (this.rejectWriteoff) return { ok: false, message: 'недостаточно остатка' };
    return { ok: true };
  }
  inventoryCount(opId: string): ApplyOutcome {
    return this.ok(`inv:${opId}`);
  }
  priceChange(opId: string): ApplyOutcome {
    return this.ok(`price:${opId}`);
  }
  createProduct(opId: string): ApplyOutcome {
    return this.ok(`create:${opId}`);
  }
}

function op(opId: string, type: string, extra: Partial<SyncOp> = {}): SyncOp {
  return { opId, type, device: 'phone', ts: 1000, data: {}, ...extra };
}

describe('engine: диспетчеризация по типу', () => {
  it('зовёт нужный метод прикладного слоя для каждого известного типа', async () => {
    const applier = new FakeApplier();
    const dedup = new InMemoryDedupStore();
    const res = await applyBatch(
      [
        op('a', optype.receive),
        op('b', optype.writeoff),
        op('c', optype.inventoryCount),
        op('d', optype.priceChange),
        op('e', optype.createProduct),
      ],
      applier,
      dedup,
    );
    expect(res.map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
    expect(applier.calls).toEqual(['receive:a', 'writeoff:b', 'inv:c', 'price:d', 'create:e']);
  });

  it('неизвестный тип → unknown_type, слой не зовётся', async () => {
    const applier = new FakeApplier();
    const res = await applyBatch([op('a', ' furniture_dance')], applier, new InMemoryDedupStore());
    expect(res[0]!.status).toBe('unknown_type');
    expect(applier.calls).toEqual([]);
  });

  it('snapshot движком не применяется', async () => {
    const applier = new FakeApplier();
    const res = await applyBatch([op('s', optype.snapshot)], applier, new InMemoryDedupStore());
    expect(res[0]!.status).toBe('unknown_type');
    expect(applier.calls).toEqual([]);
  });

  it('пустой op_id → bad_op', async () => {
    const res = await applyBatch([op('', optype.receive)], new FakeApplier(), new InMemoryDedupStore());
    expect(res[0]!.status).toBe('bad_op');
  });
});

describe('engine: дедуп по op_id (идемпотентность)', () => {
  it('повторный op_id не применяется дважды', async () => {
    const applier = new FakeApplier();
    const dedup = new InMemoryDedupStore();

    const first = await applyBatch([op('dup', optype.receive)], applier, dedup);
    expect(first[0]!.status).toBe('applied');
    expect(applier.calls).toEqual(['receive:dup']);

    // Повторная доставка того же кадра (ретрай реле/P2P).
    const retry = await applyBatch([op('dup', optype.receive)], applier, dedup);
    expect(retry[0]!.status).toBe('duplicate');
    // Прикладной слой НЕ вызван снова.
    expect(applier.calls).toEqual(['receive:dup']);
  });

  it('дубль внутри одного пакета применяется один раз', async () => {
    const applier = new FakeApplier();
    const res = await applyBatch(
      [op('x', optype.receive), op('x', optype.receive)],
      applier,
      new InMemoryDedupStore(),
    );
    expect(res.map((r) => r.status)).toEqual(['applied', 'duplicate']);
    expect(applier.calls).toEqual(['receive:x']);
  });

  it('ОТКЛОНЁННАЯ операция НЕ запоминается — может повториться позже', async () => {
    const applier = new FakeApplier();
    const dedup = new InMemoryDedupStore();
    applier.rejectWriteoff = true;

    const first = await applyBatch([op('w', optype.writeoff)], applier, dedup);
    expect(first[0]!.status).toBe('rejected');
    expect(dedup.seen('w')).toBe(false); // не запомнена

    // Условие изменилось (появился остаток) — повтор проходит.
    applier.rejectWriteoff = false;
    const retry = await applyBatch([op('w', optype.writeoff)], applier, dedup);
    expect(retry[0]!.status).toBe('applied');
    expect(dedup.seen('w')).toBe(true);
  });

  it('no-op-дубль на уровне слоя данных → duplicate, но op_id запоминается', async () => {
    const dedup = new InMemoryDedupStore();
    const applier: ISyncApplier = {
      receive: () => ({ ok: true, duplicate: true }),
      writeoff: () => ({ ok: true }),
      inventoryCount: () => ({ ok: true }),
      priceChange: () => ({ ok: true }),
      createProduct: () => ({ ok: true }),
    };
    const res = await applyBatch([op('n', optype.receive)], applier, dedup);
    expect(res[0]!.status).toBe('duplicate');
    expect(dedup.seen('n')).toBe(true);
  });
});
