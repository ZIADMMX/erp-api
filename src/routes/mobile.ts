import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { ctx, requireAuth, requireRole } from '../middleware/auth';
import { idParam, pageQuery, resolveRange, dateRangeQuery, tzQuery } from '../utils';

/**
 * تقارير الموبايل (قراءة بس) من الصفوف اللي الديسك توب بيرفعها في SyncRecord.
 * الـ ids المحلية (id / sale_id / variant_id) بتتكرر بين الأجهزة، فكل join لازم يطابق deviceId كمان.
 * المعادلات زي تقارير الديسك توب:
 *   صافي المبيعات = إجمالي المبيعات - المرتجعات
 *   الربح = صافي المبيعات - (تكلفة المبيعات - تكلفة البضاعة المرتجعة)
 */
export const mobileRouter = Router();
mobileRouter.use(requireAuth, requireRole('OWNER', 'MANAGER'));

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

// الديسك توب بيبعت التواريخ ISO؛ أي حاجة تانية بتتعامل كأنها مش موجودة بدل ما الـ cast يوقّع الطلب
const ts = (a: string, f: string) =>
  `(CASE WHEN ${a}.data->>'${f}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (${a}.data->>'${f}')::timestamptz END)`;
const num = (a: string, f: string) => `COALESCE((${a}.data->>'${f}')::numeric, 0)`;
const money = (expr: string) => `ROUND(COALESCE(${expr}, 0)::numeric, 2)::float8`;
// صفوف جدول واحد من الديسك توب لمنشأة المستخدم ($1 دايمًا tenantId)
const rows = (a: string, table: string) => `"SyncRecord" ${a} WHERE ${a}."tenantId" = $1 AND ${a}."tableName" = '${table}'`;
const same = (a: string, b: string, aField: string, bField: string) =>
  `${a}."tenantId" = $1 AND ${a}."deviceId" = ${b}."deviceId" AND ${a}.data->>'${aField}' = ${b}.data->>'${bField}'`;
// تكلفة الوحدة: المجمّدة على سطر البيع، وإلا سعر الشراء الحالي
const lineCost = `COALESCE((si.data->>'unit_cost')::numeric, (pv.data->>'purchase_price')::numeric, 0)`;
const variantOf = (si: string) => `LEFT JOIN "SyncRecord" pv ON pv."tableName" = 'product_variants' AND ${same('pv', si, 'id', 'variant_id')}`;
const productOf = `LEFT JOIN "SyncRecord" p ON p."tableName" = 'products' AND ${same('p', 'pv', 'id', 'product_id')}`;

const sql = <T>(query: string, ...params: unknown[]) => prisma.$queryRawUnsafe<T[]>(query, ...params);

const rangeQuery = dateRangeQuery.extend({ tz: tzQuery });
function range(raw: unknown) {
  const q = rangeQuery.parse(raw);
  const { from, to } = resolveRange(q);
  if (to <= from) throw new HttpError(400, 'BAD_RANGE', 'to لازم يكون بعد from');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new HttpError(400, 'BAD_RANGE', 'أقصى مدة سنة');
  return { from, to, tz: q.tz };
}

const salesIn = `SELECT s."deviceId", s.uuid, s.data FROM ${rows('s', 'sales')}
  AND ${ts('s', 'created_at')} >= $2 AND ${ts('s', 'created_at')} < $3`;

// ---------- ملخص الفترة: مبيعات / ربح / مرتجعات / طرق الدفع / يومي / أكتر أصناف ----------
mobileRouter.get('/summary', async (req, res) => {
  const { tenantId } = ctx(req);
  const { from, to, tz } = range(req.query);
  const p = [tenantId, from, to];

  const [totals, byPayment, daily, topProducts] = await Promise.all([
    sql<Record<string, number>>(`
      WITH s AS (${salesIn}),
      r AS (SELECT r."deviceId", r.data FROM ${rows('r', 'returns')}
        AND ${ts('r', 'created_at')} >= $2 AND ${ts('r', 'created_at')} < $3)
      SELECT
        (SELECT COUNT(*)::int FROM s) AS "invoiceCount",
        (SELECT ${money(`SUM(${num('s', 'total_amount')})`)} FROM s) AS "grossSales",
        (SELECT ${money(`SUM(${num('s', 'discount')})`)} FROM s) AS "discounts",
        (SELECT ${money(`SUM(${num('si', 'quantity')} * ${lineCost})`)}
           FROM s JOIN "SyncRecord" si ON si."tableName" = 'sale_items' AND ${same('si', 's', 'sale_id', 'id')}
           ${variantOf('si')}) AS "costOfSales",
        (SELECT COUNT(*)::int FROM r) AS "returnCount",
        (SELECT ${money(`SUM(${num('r', 'refund_amount')})`)} FROM r) AS "refunds",
        (SELECT ${money(`SUM(${num('r', 'quantity')} * line.cost)`)} FROM r
           LEFT JOIN LATERAL (
             SELECT ${lineCost} AS cost FROM "SyncRecord" si ${variantOf('si')}
             WHERE si."tableName" = 'sale_items' AND ${same('si', 'r', 'sale_id', 'sale_id')}
               AND si.data->>'variant_id' = r.data->>'variant_id'
             ORDER BY (si.data->>'id')::bigint LIMIT 1
           ) line ON TRUE) AS "returnedCost"`, ...p),
    sql(`
      WITH s AS (${salesIn})
      SELECT s.data->>'payment_method' AS method, COUNT(*)::int AS "invoiceCount",
             ${money(`SUM(${num('s', 'total_amount')})`)} AS total
      FROM s GROUP BY 1 ORDER BY total DESC`, ...p),
    sql(`
      WITH s AS (${salesIn})
      SELECT to_char(${ts('s', 'created_at')} AT TIME ZONE $4::text, 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS "invoiceCount", ${money(`SUM(${num('s', 'total_amount')})`)} AS total
      FROM s GROUP BY 1 ORDER BY 1`, ...p, tz),
    sql(`
      WITH s AS (${salesIn})
      SELECT COALESCE(p.data->>'name', 'صنف محذوف') AS name,
             ROUND(SUM(${num('si', 'quantity')})::numeric, 3)::float8 AS quantity,
             ${money(`SUM(${num('si', 'quantity')} * ${num('si', 'unit_price')})`)} AS revenue
      FROM s JOIN "SyncRecord" si ON si."tableName" = 'sale_items' AND ${same('si', 's', 'sale_id', 'id')}
      ${variantOf('si')} ${productOf}
      GROUP BY 1 ORDER BY revenue DESC LIMIT 10`, ...p),
  ]);

  const t = totals[0];
  const netSales = t.grossSales - t.refunds;
  res.json({
    range: { from, to, tz },
    invoiceCount: t.invoiceCount,
    grossSales: t.grossSales,
    discounts: t.discounts,
    returnCount: t.returnCount,
    refunds: t.refunds,
    netSales: round2(netSales),
    costOfSales: t.costOfSales,
    profit: round2(netSales - (t.costOfSales - t.returnedCost)),
    avgInvoice: t.invoiceCount > 0 ? round2(t.grossSales / t.invoiceCount) : 0,
    byPayment,
    daily,
    topProducts,
  });
});

const round2 = (v: number) => Math.round(v * 100) / 100;

const invoiceColumns = `s.uuid AS id, s.data->>'invoice_number' AS "invoiceNumber", ${ts('s', 'created_at')} AS "createdAt",
  ${money(num('s', 'total_amount'))} AS total, ${money(num('s', 'discount'))} AS discount,
  s.data->>'payment_method' AS "paymentMethod", s.data->>'customer_name' AS "customerName", dv.name AS "deviceName",
  (SELECT COUNT(*)::int FROM "SyncRecord" si WHERE si."tableName" = 'sale_items' AND ${same('si', 's', 'sale_id', 'id')}) AS "itemsCount"`;
const deviceOf = (a: string) => `JOIN "SyncDevice" dv ON dv.id = ${a}."deviceId"`;

// ---------- الفواتير ----------
mobileRouter.get('/invoices', async (req, res) => {
  const { tenantId } = ctx(req);
  const { from, to } = range(req.query);
  const { page, limit } = pageQuery(100).parse(req.query);
  const list = await sql(`
    WITH s AS (${salesIn})
    SELECT ${invoiceColumns} FROM s ${deviceOf('s')}
    ORDER BY "createdAt" DESC, s.uuid LIMIT $4 OFFSET $5`, tenantId, from, to, limit, (page - 1) * limit);
  res.json({ page, limit, rows: list });
});

const uuidParam = (req: Parameters<typeof idParam>[0]) => z.string().uuid('رقم غير صحيح').parse(idParam(req));

mobileRouter.get('/invoices/:id', async (req, res) => {
  const { tenantId } = ctx(req);
  const id = uuidParam(req);
  const [invoice] = await sql<Record<string, unknown>>(`
    SELECT ${invoiceColumns}, s.data->>'customer_phone' AS "customerPhone", s.data->>'notes' AS notes,
           ${money(num('s', 'service_charge'))} AS "serviceCharge", s.data->>'order_mode' AS "orderMode"
    FROM "SyncRecord" s ${deviceOf('s')}
    WHERE s."tenantId" = $1 AND s."tableName" = 'sales' AND s.uuid = $2::uuid LIMIT 1`, tenantId, id);
  if (!invoice) throw new HttpError(404, 'NOT_FOUND', 'الفاتورة غير موجودة');

  const [items, returns] = await Promise.all([
    sql(`
      SELECT si.uuid AS id, COALESCE(p.data->>'name', 'صنف محذوف') AS name,
             pv.data->>'size' AS size, pv.data->>'color' AS color,
             ROUND(${num('si', 'quantity')}, 3)::float8 AS quantity, ${money(num('si', 'unit_price'))} AS "unitPrice",
             ${money(`${num('si', 'quantity')} * ${num('si', 'unit_price')}`)} AS total, si.data->>'note' AS note
      FROM "SyncRecord" s JOIN "SyncRecord" si ON si."tableName" = 'sale_items' AND ${same('si', 's', 'sale_id', 'id')}
      ${variantOf('si')} ${productOf}
      WHERE s."tenantId" = $1 AND s."tableName" = 'sales' AND s.uuid = $2::uuid
      ORDER BY (si.data->>'id')::bigint`, tenantId, id),
    sql(`
      SELECT r.uuid AS id, ${ts('r', 'created_at')} AS "createdAt", ROUND(${num('r', 'quantity')}, 3)::float8 AS quantity,
             ${money(num('r', 'refund_amount'))} AS "refundAmount", r.data->>'reason' AS reason
      FROM "SyncRecord" s JOIN "SyncRecord" r ON r."tableName" = 'returns' AND ${same('r', 's', 'sale_id', 'id')}
      WHERE s."tenantId" = $1 AND s."tableName" = 'sales' AND s.uuid = $2::uuid
      ORDER BY "createdAt"`, tenantId, id),
  ]);
  res.json({ ...invoice, items, returns });
});

// ---------- الأصناف والمخزون (صف لكل variant في كل جهاز) ----------
const productQuery = z.object({
  q: z.string().trim().max(100).optional(),
  low: z.enum(['1', 'true']).optional(),
});
const variantColumns = `pv.uuid AS id, p.uuid AS "productId", COALESCE(p.data->>'name', '') AS name,
  pv.data->>'size' AS size, pv.data->>'color' AS color, pv.data->>'sku' AS sku, pv.data->>'barcode' AS barcode,
  ${money(num('pv', 'selling_price'))} AS price, ${money(num('pv', 'purchase_price'))} AS "purchasePrice",
  ROUND(${num('pv', 'stock_quantity')}, 3)::float8 AS stock,
  ROUND(COALESCE((pv.data->>'low_stock_threshold')::numeric, 5), 3)::float8 AS "lowStockThreshold",
  dv.name AS "deviceName"`;
const activeVariants = `FROM "SyncRecord" pv
  JOIN "SyncRecord" p ON p."tableName" = 'products' AND ${same('p', 'pv', 'id', 'product_id')}
  ${deviceOf('pv')}
  WHERE pv."tenantId" = $1 AND pv."tableName" = 'product_variants'
    AND COALESCE((p.data->>'is_active')::int, 1) = 1 AND COALESCE((p.data->>'is_service')::int, 0) = 0`;

mobileRouter.get('/products', async (req, res) => {
  const { tenantId } = ctx(req);
  const { q, low } = productQuery.parse(req.query);
  const like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
  // shortcut: أول 500 صف بس من غير صفحات، يكفي محل واحد؛ لو الأصناف كترت ضيف page/limit
  const list = await sql(`
    SELECT ${variantColumns} ${activeVariants}
      AND ($2::text IS NULL OR p.data->>'name' ILIKE $2 OR pv.data->>'sku' ILIKE $2 OR pv.data->>'barcode' ILIKE $2)
      AND ($3::boolean IS NOT TRUE OR ${num('pv', 'stock_quantity')} <= COALESCE((pv.data->>'low_stock_threshold')::numeric, 5))
    ORDER BY ${low ? 'stock ASC, name' : 'name, size, color'} LIMIT 500`, tenantId, like, Boolean(low));
  res.json(list);
});

mobileRouter.get('/products/:id', async (req, res) => {
  const { tenantId } = ctx(req);
  const id = uuidParam(req);
  const [variant] = await sql(`SELECT ${variantColumns} ${activeVariants} AND pv.uuid = $2::uuid LIMIT 1`, tenantId, id);
  if (!variant) throw new HttpError(404, 'NOT_FOUND', 'الصنف غير موجود');
  // آخر مبيعات الصنف ده (حركة المخزون نفسها مش بتترفع)
  const recentSales = await sql(`
    SELECT ${ts('s', 'created_at')} AS "createdAt", ROUND(${num('si', 'quantity')}, 3)::float8 AS quantity,
           ${money(num('si', 'unit_price'))} AS "unitPrice", s.uuid AS "invoiceId"
    FROM "SyncRecord" pv
    JOIN "SyncRecord" si ON si."tableName" = 'sale_items' AND ${same('si', 'pv', 'variant_id', 'id')}
    JOIN "SyncRecord" s ON s."tableName" = 'sales' AND ${same('s', 'si', 'id', 'sale_id')}
    WHERE pv."tenantId" = $1 AND pv."tableName" = 'product_variants' AND pv.uuid = $2::uuid
    ORDER BY "createdAt" DESC NULLS LAST LIMIT 20`, tenantId, id);
  res.json({ ...variant, recentSales });
});

// ---------- العملاء ----------
// المديونية مش هنا: دفعات العملاء (customer_payments) مش من الجداول اللي بتترفع
const customerColumns = `c.uuid AS id, c.data->>'name' AS name, c.data->>'phone' AS phone, dv.name AS "deviceName",
  COALESCE((c.data->>'is_active')::int, 1) = 1 AS "isActive",
  COALESCE(st."invoicesCount", 0) AS "invoicesCount", COALESCE(st."purchasesTotal", 0) AS "purchasesTotal",
  COALESCE(st."creditTotal", 0) AS "creditTotal", st."lastVisit"`;
const customerStats = `LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS "invoicesCount", ${money(`SUM(${num('s', 'total_amount')})`)} AS "purchasesTotal",
           ${money(`SUM(${num('s', 'total_amount')}) FILTER (WHERE s.data->>'payment_method' = 'credit')`)} AS "creditTotal",
           MAX(${ts('s', 'created_at')}) AS "lastVisit"
    FROM "SyncRecord" s WHERE s."tableName" = 'sales' AND ${same('s', 'c', 'customer_id', 'id')}
  ) st ON TRUE`;

mobileRouter.get('/customers', async (req, res) => {
  const { tenantId } = ctx(req);
  const { q } = productQuery.pick({ q: true }).parse(req.query);
  const like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
  // shortcut: أول 500 عميل بس من غير صفحات؛ لو العملاء كتروا ضيف page/limit
  const list = await sql(`
    SELECT ${customerColumns} FROM "SyncRecord" c ${deviceOf('c')} ${customerStats}
    WHERE c."tenantId" = $1 AND c."tableName" = 'customers'
      AND ($2::text IS NULL OR c.data->>'name' ILIKE $2 OR c.data->>'phone' ILIKE $2)
    ORDER BY st."lastVisit" DESC NULLS LAST, name LIMIT 500`, tenantId, like);
  res.json(list);
});

mobileRouter.get('/customers/:id', async (req, res) => {
  const { tenantId } = ctx(req);
  const id = uuidParam(req);
  const [customer] = await sql(`
    SELECT ${customerColumns} FROM "SyncRecord" c ${deviceOf('c')} ${customerStats}
    WHERE c."tenantId" = $1 AND c."tableName" = 'customers' AND c.uuid = $2::uuid LIMIT 1`, tenantId, id);
  if (!customer) throw new HttpError(404, 'NOT_FOUND', 'العميل غير موجود');
  const invoices = await sql(`
    SELECT ${invoiceColumns}
    FROM "SyncRecord" c JOIN "SyncRecord" s ON s."tableName" = 'sales' AND ${same('s', 'c', 'customer_id', 'id')}
    ${deviceOf('s')}
    WHERE c."tenantId" = $1 AND c."tableName" = 'customers' AND c.uuid = $2::uuid
    ORDER BY "createdAt" DESC NULLS LAST LIMIT 50`, tenantId, id);
  res.json({ customer, invoices });
});

// ---------- حالة الربط مع الديسك توب ----------
mobileRouter.get('/status', async (req, res) => {
  const { tenantId } = ctx(req);
  const devices = await sql(`
    SELECT d.id, d.name, d."lastSeenAt", d."revokedAt" IS NOT NULL AS revoked,
           (SELECT COUNT(*)::int FROM "SyncRecord" r WHERE r."deviceId" = d.id AND r."tableName" = 'sales') AS "salesCount"
    FROM "SyncDevice" d WHERE d."tenantId" = $1 ORDER BY d."lastSeenAt" DESC NULLS LAST`, tenantId);
  res.json({ devices });
});
