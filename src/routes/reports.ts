import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { ctx, requireAuth, requireRole } from '../middleware/auth';
import { dateRangeQuery, resolveRange, tzQuery } from '../utils';

/**
 * كل الأرقام (أرباح / تقارير) بتتحسب هنا في السيرفر بس،
 * والديسك توب والموبايل بيعرضوا النتيجة، فمستحيل الأرقام تختلف بينهم.
 *
 * الفترة: from و to بصيغة ISO (مثلًا 2026-11-01T00:00:00+02:00).
 * لو ماتبعتش: آخر 30 يوم. الفواتير الملغية (VOIDED) مش بتتحسب.
 */
export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole('OWNER', 'MANAGER'));

const dec = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);

const rangeQuery = dateRangeQuery.extend({ tz: tzQuery });

// ---------- ملخص: إيراد / تكلفة / مصروفات / صافي ربح ----------
reportsRouter.get('/summary', async (req, res) => {
  const { tenantId } = ctx(req);
  const q = rangeQuery.parse(req.query);
  const { from, to } = resolveRange(q);
  const saleWhere = { tenantId, status: 'COMPLETED' as const, createdAt: { gte: from, lte: to } };

  const [sales, expenses, costRows, byMethod] = await Promise.all([
    prisma.sale.aggregate({
      where: saleWhere,
      _sum: { total: true, discount: true, paid: true },
      _count: { _all: true },
    }),
    prisma.expense.aggregate({
      where: { tenantId, date: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
    prisma.$queryRaw<Array<{ cost: Prisma.Decimal | null }>>`
      SELECT COALESCE(SUM(si."unitCost" * si."qty"), 0) AS cost
      FROM "SaleItem" si
      JOIN "Sale" s ON s."id" = si."saleId"
      WHERE s."tenantId" = ${tenantId}
        AND s."status" = 'COMPLETED'
        AND s."createdAt" >= ${from} AND s."createdAt" <= ${to}`,
    prisma.sale.groupBy({
      by: ['method'],
      where: saleWhere,
      _sum: { total: true },
      _count: { _all: true },
    }),
  ]);

  const revenue = dec(sales._sum.total);
  const cost = dec(costRows[0]?.cost);
  const expensesTotal = dec(expenses._sum.amount);
  const grossProfit = revenue.minus(cost);

  res.json({
    range: { from, to },
    salesCount: sales._count._all,
    revenue, // إجمالي المبيعات بعد الخصم
    discounts: dec(sales._sum.discount),
    receivable: revenue.minus(dec(sales._sum.paid)), // آجل لسه ماتدفعش
    cost, // تكلفة البضاعة المباعة
    grossProfit, // مجمل الربح = الإيراد - التكلفة
    expenses: expensesTotal,
    netProfit: grossProfit.minus(expensesTotal), // صافي الربح
    byMethod: byMethod.map((m) => ({ method: m.method, count: m._count._all, total: dec(m._sum.total) })),
  });
});

// ---------- مبيعات وأرباح يوم بيوم ----------
reportsRouter.get('/daily', async (req, res) => {
  const { tenantId } = ctx(req);
  const q = rangeQuery.parse(req.query);
  const { from, to } = resolveRange(q);

  const rows = await prisma.$queryRaw<
    Array<{ day: Date; salesCount: number; revenue: Prisma.Decimal; cost: Prisma.Decimal }>
  >`
    SELECT d."day" AS day,
           COUNT(*)::int AS "salesCount",
           SUM(d."total") AS revenue,
           SUM(d."cost") AS cost
    FROM (
      SELECT ((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${q.tz})::date AS "day",
             s."total" AS "total",
             COALESCE((SELECT SUM(si."unitCost" * si."qty") FROM "SaleItem" si WHERE si."saleId" = s."id"), 0) AS "cost"
      FROM "Sale" s
      WHERE s."tenantId" = ${tenantId}
        AND s."status" = 'COMPLETED'
        AND s."createdAt" >= ${from} AND s."createdAt" <= ${to}
    ) d
    GROUP BY d."day"
    ORDER BY d."day" ASC`;

  res.json({
    range: { from, to },
    tz: q.tz,
    days: rows.map((r) => ({
      date: r.day.toISOString().slice(0, 10),
      salesCount: r.salesCount,
      revenue: dec(r.revenue),
      cost: dec(r.cost),
      profit: dec(r.revenue).minus(dec(r.cost)),
    })),
  });
});

// ---------- أكتر الأصناف مبيعًا / ربحًا ----------
// (الربح هنا قبل الخصم على مستوى الفاتورة، فمجموعه ممكن يزيد عن مجمل الربح في /summary)
reportsRouter.get('/top-products', async (req, res) => {
  const { tenantId } = ctx(req);
  const q = rangeQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(10) }).parse(req.query);
  const { from, to } = resolveRange(q);

  const rows = await prisma.$queryRaw<
    Array<{ productId: string | null; name: string; qty: number; revenue: Prisma.Decimal; profit: Prisma.Decimal }>
  >`
    SELECT si."productId" AS "productId",
           si."name" AS name,
           SUM(si."qty")::int AS qty,
           SUM(si."unitPrice" * si."qty") AS revenue,
           SUM((si."unitPrice" - si."unitCost") * si."qty") AS profit
    FROM "SaleItem" si
    JOIN "Sale" s ON s."id" = si."saleId"
    WHERE s."tenantId" = ${tenantId}
      AND s."status" = 'COMPLETED'
      AND s."createdAt" >= ${from} AND s."createdAt" <= ${to}
    GROUP BY si."productId", si."name"
    ORDER BY profit DESC
    LIMIT ${q.limit}`;

  res.json({
    range: { from, to },
    items: rows.map((r) => ({
      productId: r.productId,
      name: r.name,
      qty: r.qty,
      revenue: dec(r.revenue),
      profit: dec(r.profit),
    })),
  });
});

// ---------- أداء كل موظف ----------
reportsRouter.get('/by-user', async (req, res) => {
  const { tenantId } = ctx(req);
  const q = dateRangeQuery.parse(req.query);
  const { from, to } = resolveRange(q);

  const groups = await prisma.sale.groupBy({
    by: ['userId'],
    where: { tenantId, status: 'COMPLETED', createdAt: { gte: from, lte: to } },
    _sum: { total: true },
    _count: { _all: true },
  });
  const users = await prisma.user.findMany({
    where: { tenantId, id: { in: groups.map((g) => g.userId) } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name]));

  res.json({
    range: { from, to },
    items: groups
      .map((g) => ({
        userId: g.userId,
        name: names.get(g.userId) ?? '—',
        salesCount: g._count._all,
        total: dec(g._sum.total),
      }))
      .sort((a, b) => b.total.comparedTo(a.total)),
  });
});

// ---------- قيمة المخزون الحالية ----------
reportsRouter.get('/inventory', async (req, res) => {
  const { tenantId } = ctx(req);
  const rows = await prisma.$queryRaw<
    Array<{ costValue: Prisma.Decimal; retailValue: Prisma.Decimal; items: number; lowStockCount: number }>
  >`
    SELECT COALESCE(SUM("cost" * "qty"), 0) AS "costValue",
           COALESCE(SUM("price" * "qty"), 0) AS "retailValue",
           COUNT(*)::int AS items,
           (COUNT(*) FILTER (WHERE "qty" <= "minQty"))::int AS "lowStockCount"
    FROM "Product"
    WHERE "tenantId" = ${tenantId} AND "trackStock" = true AND "active" = true`;

  const r = rows[0];
  res.json({
    items: r?.items ?? 0,
    lowStockCount: r?.lowStockCount ?? 0,
    costValue: dec(r?.costValue),
    retailValue: dec(r?.retailValue),
  });
});
