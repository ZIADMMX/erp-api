import { Router } from 'express';
import { MovementType, type Prisma, type Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { notifyLowStock } from '../inventory';
import { ctx, requireAuth, requireRole } from '../middleware/auth';
import { emitChange } from '../realtime';
import { optStr, pageQuery, skipTake } from '../utils';

export const productsRouter = Router();
productsRouter.use(requireAuth);

// التكلفة (سعر الشراء) بتظهر للمالك والمدير بس، مش للكاشير
const canSeeCost = (role: Role) => role === 'OWNER' || role === 'MANAGER';
function shape<T extends { cost?: unknown }>(p: T, role: Role) {
  if (canSeeCost(role)) return p;
  const { cost: _cost, ...rest } = p;
  return rest;
}

const productBase = z.object({
  name: z.string().trim().min(1).max(200),
  sku: optStr(64),
  barcode: optStr(64),
  category: optStr(100),
  cost: z.number().min(0).max(1e9).default(0),
  price: z.number().min(0).max(1e9),
  qty: z.number().int().min(0).default(0),
  minQty: z.number().int().min(0).default(0),
  trackStock: z.boolean().default(true),
  active: z.boolean().default(true),
});

async function mustFind(tenantId: string, id: string) {
  const p = await prisma.product.findFirst({ where: { id, tenantId } });
  if (!p) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'الصنف غير موجود');
  return p;
}

const listQuery = pageQuery(1000).extend({
  q: z.string().trim().optional(),
  category: z.string().trim().optional(),
  lowStock: z.enum(['true', 'false']).optional(),
  active: z.enum(['true', 'false', 'all']).default('true'),
});

productsRouter.get('/', async (req, res) => {
  const { tenantId, role } = ctx(req);
  const q = listQuery.parse(req.query);

  // الأصناف اللي وصلت للحد الأدنى (مقارنة عمودين، فبنستخدم SQL مباشر)
  if (q.lowStock === 'true') {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "Product"
      WHERE "tenantId" = ${tenantId} AND "trackStock" = true AND "active" = true AND "qty" <= "minQty"
      ORDER BY "qty" ASC, "name" ASC
      LIMIT ${q.limit}`;
    res.json({ items: rows.map((r) => shape(r, role)), total: rows.length, page: 1, limit: q.limit });
    return;
  }

  const where: Prisma.ProductWhereInput = {
    tenantId,
    ...(q.active === 'all' ? {} : { active: q.active === 'true' }),
    ...(q.category ? { category: q.category } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { sku: { contains: q.q, mode: 'insensitive' } },
            { barcode: q.q },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({ where, orderBy: { name: 'asc' }, ...skipTake(q) }),
    prisma.product.count({ where }),
  ]);
  res.json({ items: items.map((p) => shape(p, role)), total, page: q.page, limit: q.limit });
});

productsRouter.get('/:id', async (req, res) => {
  const { tenantId, role } = ctx(req);
  res.json(shape(await mustFind(tenantId, req.params.id), role));
});

productsRouter.post('/', requireRole('OWNER', 'MANAGER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const body = productBase.parse(req.body);

  const product = await prisma.$transaction(async (tx) => {
    const p = await tx.product.create({ data: { ...body, tenantId } });
    if (p.trackStock && p.qty > 0) {
      await tx.stockMovement.create({
        data: { tenantId, productId: p.id, userId, type: MovementType.ADJUSTMENT, delta: p.qty, reason: 'رصيد افتتاحي' },
      });
    }
    return p;
  });

  emitChange(tenantId, { entity: 'products', action: 'created', id: product.id, by: userId });
  res.status(201).json(product);
});

// تعديل بيانات الصنف. الكمية بتتعدّل من /adjust عشان تتسجل في سجل الحركة.
const updateSchema = productBase.omit({ qty: true }).partial();

productsRouter.patch('/:id', requireRole('OWNER', 'MANAGER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const body = updateSchema.parse(req.body);
  await mustFind(tenantId, req.params.id);
  const product = await prisma.product.update({ where: { id: req.params.id }, data: body });
  emitChange(tenantId, { entity: 'products', action: 'updated', id: product.id, by: userId });
  res.json(product);
});

// تسوية المخزون يدويًا (جرد / استلام بضاعة / تالف). delta موجب = زيادة، سالب = نقص.
productsRouter.post('/:id/adjust', requireRole('OWNER', 'MANAGER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const id = req.params.id;
  const body = z
    .object({
      delta: z.number().int().refine((n) => n !== 0, 'الكمية لازم تكون غير صفر'),
      reason: z.string().trim().max(200).optional(),
    })
    .parse(req.body);

  const before = await mustFind(tenantId, id);
  if (!before.trackStock) throw new HttpError(400, 'NOT_TRACKED', 'الصنف ده مش بيتتبع في المخزون');

  const updated = await prisma.$transaction(async (tx) => {
    // الخصم مشروط بوجود الكمية في نفس الأمر، فمفيش مخزون بالسالب حتى مع عمليات متزامنة
    const r = await tx.product.updateMany({
      where: { id, tenantId, ...(body.delta < 0 ? { qty: { gte: -body.delta } } : {}) },
      data: { qty: { increment: body.delta } },
    });
    if (r.count === 0) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'الكمية المتاحة أقل من الكمية المطلوب خصمها');
    await tx.stockMovement.create({
      data: { tenantId, productId: id, userId, type: MovementType.ADJUSTMENT, delta: body.delta, reason: body.reason },
    });
    return tx.product.findFirstOrThrow({ where: { id, tenantId } });
  });

  emitChange(tenantId, { entity: 'products', action: 'stock', id, by: userId });
  if (body.delta < 0) void notifyLowStock(tenantId, [{ id, qtyBefore: before.qty }]);
  res.json(updated);
});

// سجل حركة صنف معين
productsRouter.get('/:id/movements', requireRole('OWNER', 'MANAGER'), async (req, res) => {
  const { tenantId } = ctx(req);
  const q = pageQuery(200).parse(req.query);
  await mustFind(tenantId, req.params.id);
  const where = { tenantId, productId: req.params.id };
  const [items, total] = await Promise.all([
    prisma.stockMovement.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
    prisma.stockMovement.count({ where }),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
});

// "الحذف" إيقاف للصنف (بيفضل ظاهر في الفواتير القديمة والتقارير)
productsRouter.delete('/:id', requireRole('OWNER', 'MANAGER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  await mustFind(tenantId, req.params.id);
  await prisma.product.update({ where: { id: req.params.id }, data: { active: false } });
  emitChange(tenantId, { entity: 'products', action: 'deleted', id: req.params.id, by: userId });
  res.status(204).end();
});
