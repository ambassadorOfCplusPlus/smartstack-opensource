import { describe, it, expect } from 'vitest';
import {
  generateKey,
  keyToString,
  keyFromString,
  newOpId,
  buildBatchJson,
  parseBatchJson,
  encodeFrame,
  decodeFrame,
  encodeFrameBase64,
  decodeFrameBase64,
  encodeBatchBase64,
  decodeBatchBase64,
  type SyncOp,
} from './codec';

function ops(): SyncOp[] {
  return [
    { opId: 'op_1', type: 'receive', device: 'phone', ts: 1000, data: { productId: 'p1', qty: 100 } },
    { opId: 'op_2', type: 'writeoff', device: 'phone', ts: 1001, data: { productId: 'p1', qty: 30 } },
  ];
}

describe('codec: ключи и op_id', () => {
  it('generateKey даёт 32 байта, round-trip через строку', () => {
    const k = generateKey();
    expect(k.length).toBe(32);
    expect(keyFromString(keyToString(k)).equals(k)).toBe(true);
  });

  it('keyFromString отвергает ключ неверной длины', () => {
    expect(() => keyFromString('QUJD')).toThrow(/длина/);
  });

  it('newOpId уникален и с префиксом op_', () => {
    const a = newOpId();
    const b = newOpId();
    expect(a).toMatch(/^op_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('codec: кадр round-trip (encrypt → decrypt)', () => {
  it('шифрует и расшифровывает произвольный текст', () => {
    const key = generateKey();
    const text = 'привет мир — журнал синхронизации 42';
    const frame = encodeFrame(text, key);
    expect(decodeFrame(frame, key)).toBe(text);
  });

  it('base64-обёртка round-trip', () => {
    const key = generateKey();
    const b64 = encodeFrameBase64('данные', key);
    expect(decodeFrameBase64(b64, key)).toBe('данные');
  });

  it('сжимает крупный сжимаемый payload (флаг compressed), но всё равно расшифровывает', () => {
    const key = generateKey();
    const text = 'A'.repeat(5000); // хорошо сжимается
    const frame = encodeFrame(text, key);
    // Кадр заметно меньше сырого текста → сжатие сработало.
    expect(frame.length).toBeLessThan(text.length);
    expect(decodeFrame(frame, key)).toBe(text);
  });

  it('пакет операций → кадр base64 → тот же пакет', () => {
    const key = generateKey();
    const b64 = encodeBatchBase64(ops(), key);
    const back = decodeBatchBase64(b64, key);
    expect(back).toEqual(ops());
  });
});

describe('codec: целостность (битый tag / чужой ключ → ошибка)', () => {
  it('порча последнего байта (tag GCM) → ошибка подлинности', () => {
    const key = generateKey();
    const frame = encodeFrame('секрет', key);
    frame[frame.length - 1] ^= 0xff; // ломаем тег
    expect(() => decodeFrame(frame, key)).toThrow(/подлинност/);
  });

  it('порча шифротекста → ошибка', () => {
    const key = generateKey();
    const frame = encodeFrame('секрет', key);
    frame[7] ^= 0x01; // байт внутри iv/ct-области
    expect(() => decodeFrame(frame, key)).toThrow();
  });

  it('чужой ключ → ошибка (а не мусор)', () => {
    const frame = encodeFrame('секрет', generateKey());
    expect(() => decodeFrame(frame, generateKey())).toThrow(/подлинност/);
  });

  it('подделка заголовка (AAD) → ошибка', () => {
    const key = generateKey();
    const frame = encodeFrame('секрет', key);
    frame[5] ^= 0x01; // флаги — часть AAD
    expect(() => decodeFrame(frame, key)).toThrow();
  });

  it('слишком короткий/неверная сигнатура → ошибка', () => {
    const key = generateKey();
    expect(() => decodeFrame(Buffer.from([1, 2, 3]), key)).toThrow(/короткий/);
    const bad = encodeFrame('x', key);
    bad[0] ^= 0xff;
    expect(() => decodeFrame(bad, key)).toThrow(/сигнатура/);
  });
});

describe('codec: JSON-пакет устойчив к битым элементам', () => {
  it('пропускает не-объект и поле неверного типа, сохраняя валидные', () => {
    const good = buildBatchJson(ops());
    const parsed = JSON.parse(good);
    parsed.ops.push(42); // мусор
    parsed.ops.push({ op_id: 'op_x', type: 5, device: 'd', ts: 'нет', data: {} }); // кривые типы
    const back = parseBatchJson(JSON.stringify(parsed));
    // Оба исходных ops сохранены; мусорный пропущен; кривой добавлен с дефолтами.
    expect(back.map((o) => o.opId)).toEqual(['op_1', 'op_2', 'op_x']);
    const x = back.find((o) => o.opId === 'op_x')!;
    expect(x.type).toBe(''); // type не строка → дефолт
    expect(x.ts).toBe(0); // ts не число → дефолт
  });

  it('некорректный JSON / нет массива ops → ошибка', () => {
    expect(() => parseBatchJson('{ не json')).toThrow(/JSON/);
    expect(() => parseBatchJson('{"v":1}')).toThrow(/ops/);
  });
});
