// رفع الديسك توب على Neon فعلًا: محتاج DIRECT_URL في .env. بيعمل منشأة مؤقتة ويمسحها في الآخر.
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const enabled = Boolean(process.env.DIRECT_URL);
if (enabled) process.env.DATABASE_URL = process.env.DIRECT_URL;

const key = `fsk_${crypto.randomBytes(32).toString('base64url')}`;
const uuid = crypto.randomUUID();
let base = '';
let close = () => {};
let tenantId = '';
let count = async (): Promise<number> => 0;

const push = (records: object[]) =>
  fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ records }),
  });

before(async () => {
  if (!enabled) return;
  const { app } = await import('./app');
  const { prisma } = await import('./db');
  const { hashToken } = await import('./tokens');
  const tenant = await prisma.tenant.create({ data: { name: 'sync-test' } });
  tenantId = tenant.id;
  await prisma.syncDevice.create({ data: { tenantId, name: 'pc', keyHash: hashToken(key) } });
  count = () => prisma.syncRecord.count({ where: { tenantId, uuid } });
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    server.close();
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  };
});

after(() => close());

test('a deleted row leaves the server, an older deletion does not', { skip: !enabled }, async () => {
  const row = { table: 'product_variants', uuid, updated_at: '2026-01-02T00:00:00.000Z', data: { id: 1 } };
  assert.equal((await push([row])).status, 200);
  assert.equal(await count(), 1);

  await push([{ ...row, updated_at: '2026-01-01T00:00:00.000Z', deleted: true, data: {} }]);
  assert.equal(await count(), 1, 'a deletion older than the row keeps it');

  assert.equal((await push([{ ...row, updated_at: '2026-01-03T00:00:00.000Z', deleted: true, data: {} }])).status, 200);
  assert.equal(await count(), 0);
});
