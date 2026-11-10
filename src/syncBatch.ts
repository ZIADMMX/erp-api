// التحقق من دفعة الديسك توب. ملف من غير داتابيز عشان يتختبر من غير .env
import { HttpError } from './errors';

// لازم تطابق SYNC_TABLES في الديسك توب (electron/database/migrations/syncMetadata.js)
export const SYNC_TABLES = ['sales', 'sale_items', 'products', 'product_variants', 'customers', 'returns', 'shifts', 'orders'];
export const MAX_RECORDS = 500;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SyncRow {
  table: string;
  uuid: string;
  updatedAt: string;
  data: object;
}

const bad = (message: string) => new HttpError(400, 'BAD_SYNC_BATCH', message);

/**
 * بيتأكد من دفعة الديسك توب ويرجّع صف واحد لكل (table, uuid)، الأحدث بيكسب.
 * أي حاجة غلط بترفض الدفعة كلها عشان العميل المعطوب يبان على طول.
 */
export function validateBatch(body: unknown, now = Date.now()): SyncRow[] {
  const records = (body as { records?: unknown })?.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RECORDS) {
    throw bad(`records لازم تكون قائمة من 1 لـ ${MAX_RECORDS} صف`);
  }
  const byKey = new Map<string, { table: string; uuid: string; time: number; data: object }>();
  for (const record of records) {
    const { table, uuid, updated_at: updatedAt, data } = (record ?? {}) as Record<string, unknown>;
    if (typeof table !== 'string' || !SYNC_TABLES.includes(table)) throw bad(`جدول غير مسموح بمزامنته: ${String(table).slice(0, 40)}`);
    if (typeof uuid !== 'string' || !UUID.test(uuid)) throw bad('uuid غير صالح');
    const time = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
    if (Number.isNaN(time)) throw bad('updated_at غير صالح');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('data لازم تكون كائن');
    // ساعة جهاز متقدمة كانت هتخلي الصف يكسب كل تحديث بعده، فبنرجّعها للوقت الحالي
    const clamped = Math.min(time, now + MAX_FUTURE_MS);
    const key = `${table}:${uuid.toLowerCase()}`;
    const previous = byKey.get(key);
    if (!previous || previous.time <= clamped) {
      byKey.set(key, { table, uuid: uuid.toLowerCase(), time: clamped, data });
    }
  }
  return [...byKey.values()].map(({ table, uuid, time, data }) => ({
    table,
    uuid,
    updatedAt: new Date(time).toISOString(),
    data,
  }));
}
