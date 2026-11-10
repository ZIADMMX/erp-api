import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RECORDS, validateBatch } from './syncBatch';

const uuid = '0b0e5c8a-1f2d-4c3b-9a8e-7d6c5b4a3f21';
const row = (over: Record<string, unknown> = {}) => ({
  table: 'sales', uuid, updated_at: '2026-01-01T10:00:00.000Z', data: { id: 1 }, ...over,
});

test('keeps the newest copy of a repeated row', () => {
  const rows = validateBatch({
    records: [row({ data: { v: 2 }, updated_at: '2026-01-02T00:00:00Z' }), row({ data: { v: 1 } })],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].data, { v: 2 });
});

test('pulls a future clock back to now', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const [r] = validateBatch({ records: [row({ updated_at: '2030-01-01T00:00:00Z' })] }, now);
  assert.equal(r.updatedAt, new Date(now + 5 * 60 * 1000).toISOString());
});

test('rejects bad batches', () => {
  assert.throws(() => validateBatch({ records: [] }));
  assert.throws(() => validateBatch({ records: Array(MAX_RECORDS + 1).fill(row()) }));
  assert.throws(() => validateBatch({ records: [row({ table: 'users' })] }), /غير مسموح/);
  assert.throws(() => validateBatch({ records: [row({ uuid: 'x' })] }), /uuid/);
  assert.throws(() => validateBatch({ records: [row({ updated_at: 'nope' })] }), /updated_at/);
  assert.throws(() => validateBatch({ records: [row({ data: [1] })] }), /data/);
});

test('a deletion is the newest copy only when it is newer', () => {
  const [gone] = validateBatch({ records: [row(), row({ updated_at: '2026-01-02T00:00:00Z', deleted: true, data: {} })] });
  assert.equal(gone.deleted, true);
  const [kept] = validateBatch({ records: [row({ updated_at: '2026-01-03T00:00:00Z' }), row({ updated_at: '2026-01-02T00:00:00Z', deleted: true, data: {} })] });
  assert.equal(kept.deleted, false);
});
