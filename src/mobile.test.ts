// تقارير الموبايل على Neon فعلًا: محتاج DIRECT_URL في .env (الـ pooled بطيء من الجهاز ده).
// بيعمل منشأتين مؤقتتين ويمسحهم في الآخر.
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const enabled = Boolean(process.env.DIRECT_URL);
if (enabled) process.env.DATABASE_URL = process.env.DIRECT_URL;

let base = '';
let close = () => {};
let cleanup = async () => {};
const token: Record<string, string> = {};
const ids: Record<string, string> = {};

const get = async (path: string, who = 'owner') => {
  const res = await fetch(`${base}${path}`, { headers: token[who] ? { Authorization: `Bearer ${token[who]}` } : {} });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  if (!enabled) return;
  const { app } = await import('./app');
  const { prisma } = await import('./db');
  const { signAccessToken } = await import('./tokens');

  const tenant = await prisma.tenant.create({ data: { name: 'mobile-test' } });
  const other = await prisma.tenant.create({ data: { name: 'mobile-test-other' } });
  const device = (tenantId: string, name: string) =>
    prisma.syncDevice.create({ data: { tenantId, name, keyHash: crypto.randomBytes(16).toString('hex') } });
  const [a, b, o] = await Promise.all([device(tenant.id, 'سموحة'), device(tenant.id, 'ميامي'), device(other.id, 'x')]);

  const records: Array<[string, string, string, object]> = [];
  const add = (dev: string, table: string, data: object, key = `${dev}:${table}:${(data as { id: number }).id}`) => {
    ids[key] = crypto.randomUUID();
    records.push([dev, tenantOf[dev], table, data]);
    recordIds.push(ids[key]);
  };
  const tenantOf: Record<string, string> = { [a.id]: tenant.id, [b.id]: tenant.id, [o.id]: other.id };
  const recordIds: string[] = [];
  const at = (iso: string) => ({ created_at: iso });

  add(a.id, 'products', { id: 1, name: 'قهوة', is_active: 1, is_service: 0 });
  add(a.id, 'product_variants', { id: 10, product_id: 1, size: 'L', purchase_price: 20, selling_price: 50, stock_quantity: 3, low_stock_threshold: 5 });
  add(a.id, 'product_variants', { id: 11, product_id: 1, size: 'S', purchase_price: 10, selling_price: 30, stock_quantity: 50, low_stock_threshold: 5 });
  add(a.id, 'customers', { id: 7, name: 'أحمد', phone: '0100', is_active: 1 });
  add(a.id, 'sales', { id: 100, total_amount: 130, discount: 0, payment_method: 'cash', customer_id: 7, customer_name: 'أحمد', ...at('2026-11-09T10:00:00.000Z') });
  add(a.id, 'sale_items', { id: 1000, sale_id: 100, variant_id: 10, quantity: 2, unit_price: 50, unit_cost: 20 });
  add(a.id, 'sale_items', { id: 1001, sale_id: 100, variant_id: 11, quantity: 1, unit_price: 30 });
  add(a.id, 'sales', { id: 101, total_amount: 50, discount: 0, payment_method: 'credit', customer_id: 7, ...at('2026-11-09T23:30:00.000Z') });
  add(a.id, 'sale_items', { id: 1002, sale_id: 101, variant_id: 10, quantity: 1, unit_price: 50, unit_cost: 20 });
  add(a.id, 'returns', { id: 1, sale_id: 100, variant_id: 10, quantity: 1, refund_amount: 50, ...at('2026-11-09T11:00:00.000Z') });
  add(a.id, 'sales', { id: 50, total_amount: 70, payment_method: 'cash', ...at('2026-10-01T10:00:00.000Z') }); // برا الفترة
  // جهاز تاني بنفس الـ ids المحلية: لازم مايتلخبطش مع الأول
  add(b.id, 'sales', { id: 100, total_amount: 999, payment_method: 'cash', ...at('2026-11-09T12:00:00.000Z') });
  add(b.id, 'sale_items', { id: 1000, sale_id: 100, variant_id: 10, quantity: 1, unit_price: 999, unit_cost: 1 });
  add(o.id, 'sales', { id: 100, total_amount: 5000, payment_method: 'cash', ...at('2026-11-09T12:00:00.000Z') });

  await prisma.$executeRaw`
    INSERT INTO "SyncRecord" ("deviceId", "tenantId", "tableName", "uuid", "updatedAt", "data")
    SELECT * FROM unnest(${records.map((r) => r[0])}::text[], ${records.map((r) => r[1])}::text[],
      ${records.map((r) => r[2])}::text[], ${recordIds}::uuid[],
      ${records.map(() => new Date())}::timestamptz[], ${records.map((r) => JSON.stringify(r[3]))}::jsonb[])`;

  token.owner = signAccessToken({ sub: 'u1', tid: tenant.id, role: 'OWNER' });
  token.cashier = signAccessToken({ sub: 'u2', tid: tenant.id, role: 'CASHIER' });
  token.other = signAccessToken({ sub: 'u3', tid: other.id, role: 'OWNER' });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mobile`;
  close = () => server.close();
  cleanup = async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, other.id] } } });
    await prisma.$disconnect();
  };
});

after(async () => {
  close();
  await cleanup();
});

const range = 'from=2026-11-09T00:00:00Z&to=2026-11-11T00:00:00Z&tz=Africa/Cairo';
const opts = { skip: !enabled && 'DIRECT_URL مش موجود' };

test('summary: totals, profit, days in the shop time zone, payments, top products', opts, async () => {
  const { status, body } = await get(`/summary?${range}`);
  assert.equal(status, 200);
  assert.equal(body.invoiceCount, 3);
  assert.equal(body.grossSales, 1179);
  assert.equal(body.costOfSales, 71); // 2*20 + 1*10 (سعر الشراء) + 20 + 1
  assert.equal(body.refunds, 50);
  assert.equal(body.netSales, 1129);
  assert.equal(body.profit, 1078); // 1129 - (71 - 20)
  assert.deepEqual(body.daily, [
    { day: '2026-11-09', invoiceCount: 2, total: 1129 },
    { day: '2026-11-10', invoiceCount: 1, total: 50 },
  ]);
  assert.deepEqual(body.byPayment, [
    { method: 'cash', invoiceCount: 2, total: 1129 },
    { method: 'credit', invoiceCount: 1, total: 50 },
  ]);
  assert.deepEqual(body.topProducts, [
    { name: 'صنف محذوف', quantity: 1, revenue: 999 },
    { name: 'قهوة', quantity: 4, revenue: 180 },
  ]);
});

test('invoices list and details keep each device apart', opts, async () => {
  const { body } = await get(`/invoices?${range}`);
  assert.deepEqual(body.rows.map((r: { total: number }) => r.total), [50, 999, 130]);
  const first = body.rows.find((r: { total: number }) => r.total === 130);
  assert.equal(first.itemsCount, 2);
  assert.equal(first.deviceName, 'سموحة');

  const detail = await get(`/invoices/${first.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.items.map((i: { name: string; total: number }) => [i.name, i.total]), [['قهوة', 100], ['قهوة', 30]]);
  assert.equal(detail.body.returns.length, 1);
  assert.equal((await get(`/invoices/${crypto.randomUUID()}`)).status, 404);
});

test('products, low stock and one product', opts, async () => {
  assert.equal((await get('/products')).body.length, 2);
  const low = (await get('/products?low=1')).body;
  assert.deepEqual(low.map((v: { size: string; stock: number }) => [v.size, v.stock]), [['L', 3]]);
  assert.equal((await get('/products?q=قهو')).body.length, 2);
  const one = await get(`/products/${low[0].id}`);
  assert.equal(one.body.recentSales.length, 2);
});

test('customers with their purchases', opts, async () => {
  const [c] = (await get('/customers')).body;
  assert.equal(c.name, 'أحمد');
  assert.equal(c.invoicesCount, 2);
  assert.equal(c.purchasesTotal, 180);
  assert.equal(c.creditTotal, 50);
  const detail = await get(`/customers/${c.id}`);
  assert.equal(detail.body.invoices.length, 2);
});

test('auth: no token, wrong role, other tenant sees nothing', opts, async () => {
  assert.equal((await get('/summary', 'nobody')).status, 401);
  assert.equal((await get('/summary', 'cashier')).status, 403);
  const other = await get(`/summary?${range}`, 'other');
  assert.equal(other.body.invoiceCount, 1);
  assert.equal(other.body.grossSales, 5000);
  assert.equal((await get('/customers', 'other')).body.length, 0);
  assert.equal((await get('/invoices/not-a-uuid')).status, 400);
});
