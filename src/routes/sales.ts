import { Router } from 'express';
import { MovementType, PaymentMethod, Prisma, SaleStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { notifyLowStock } from '../inventory';
import { ctx, requireAuth, requireRole } from '../middleware/auth';
import { emitChange } from '../realtime';
import { dateRangeQuery, idParam, pageQuery, rangeFilter, skipTake } from '../utils';

export const salesRouter = Router();
salesRouter.use(requireAuth);

const itemSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().min(1).max(100000),
  // تعديل السعر وقت البيع مسموح للمالك والمدير بس. للكاشير بيتتجاهل ويتاخد سعر الصنف.
  unitPrice: z.number().min(0).max(1e9).optional(),
});

const createSchema = z.object({
  customerId: z.string().min(1).nullish(),
  items: z.array(itemSchema).min(1).max(200),
  discount: z.number().min(0).max(1e9).default(0),
  // لو مابعتش paid بيتعتبر مدفوع بالكامل. أقل من الإجمالي = بيع آجل (لازم عميل).
  paid: z.number().min(0).max(1e10).optional(),
  method: z.nativeEnum(PaymentMethod).default(PaymentMethod.CASH),
  note: z.string().trim().max(500).nullish(),
});

/**
 * إنشاء فاتورة. كل حاجة بتتم في Transaction واحدة:
 *  1) رقم الفاتورة (بيقفل صف المنشأة، فالكاشيرات المتزامنين بيتسلسلوا ومفيش تكرار أو Deadlock)
 *  2) خصم المخزون بشرط وجود الكمية في نفس أمر الـ UPDATE → مستحيل يتباع آخر صنف مرتين
 *  3) الأسعار والتكلفة والإجماليات بتتحسب هنا في السيرفر، مش من العميل
 */
salesRouter.post('/', requireRole('OWNER', 'MANAGER', 'CASHIER'), async (req, res) => {
  const { tenantId, userId, role } = ctx(req);
  const body = createSchema.parse(req.body);
  const canOverridePrice = role === 'OWNER' || role === 'MANAGER';

  // دمج الأصناف المكررة + ترتيب ثابت
  const merged = new Map<string, { qty: number; unitPrice?: number }>();
  for (const it of body.items) {
    const cur = merged.get(it.productId);
    if (cur) cur.qty += it.qty;
    else merged.set(it.productId, { qty: it.qty, unitPrice: it.unitPrice });
  }
  const productIds = [...merged.keys()].sort();

  const { sale, tracked } = await prisma.$transaction(
    async (tx) => {
      if (body.customerId) {
        const c = await tx.customer.findFirst({ where: { id: body.customerId, tenantId }, select: { id: true } });
        if (!c) throw new HttpError(400, 'CUSTOMER_NOT_FOUND', 'العميل غير موجود');
      }

      const { saleCounter } = await tx.tenant.update({
        where: { id: tenantId },
        data: { saleCounter: { increment: 1 } },
        select: { saleCounter: true },
      });

      const products = await tx.product.findMany({ where: { id: { in: productIds }, tenantId, active: true } });
      if (products.length !== productIds.length) {
        throw new HttpError(400, 'PRODUCT_NOT_FOUND', 'في صنف مش موجود أو موقوف');
      }
      const byId = new Map(products.map((p) => [p.id, p]));

      let subtotal = new Prisma.Decimal(0);
      const items: Prisma.SaleItemCreateManySaleInput[] = [];
      const movements: Array<{ productId: string; delta: number }> = [];
      const tracked: Array<{ id: string; qtyBefore: number }> = [];

      for (const id of productIds) {
        const line = merged.get(id)!;
        const p = byId.get(id)!;

        if (p.trackStock) {
          const upd = await tx.product.updateMany({
            where: { id, tenantId, qty: { gte: line.qty } },
            data: { qty: { decrement: line.qty } },
          });
          if (upd.count === 0) {
            throw new HttpError(409, 'OUT_OF_STOCK', `الكمية غير كافية للصنف: ${p.name}`);
          }
          movements.push({ productId: id, delta: -line.qty });
          tracked.push({ id, qtyBefore: p.qty });
        }

        const unitPrice =
          canOverridePrice && line.unitPrice !== undefined ? new Prisma.Decimal(line.unitPrice) : p.price;
        subtotal = subtotal.plus(unitPrice.times(line.qty));
        items.push({ productId: id, name: p.name, qty: line.qty, unitPrice, unitCost: p.cost });
      }

      const discount = new Prisma.Decimal(body.discount);
      if (discount.gt(subtotal)) throw new HttpError(400, 'DISCOUNT_TOO_HIGH', 'الخصم أكبر من إجمالي الفاتورة');
      const total = subtotal.minus(discount);

      const paid = body.paid !== undefined ? new Prisma.Decimal(body.paid) : total;
      if (paid.gt(total)) throw new HttpError(400, 'PAID_EXCEEDS_TOTAL', 'المدفوع أكبر من إجمالي الفاتورة');
      if (paid.lt(total) && !body.customerId) {
        throw new HttpError(400, 'CUSTOMER_REQUIRED', 'البيع الآجل لازم يتسجل على عميل');
      }

      const sale = await tx.sale.create({
        data: {
          tenantId,
          number: saleCounter,
          userId,
          customerId: body.customerId ?? null,
          subtotal,
          discount,
          total,
          paid,
          method: body.method,
          note: body.note ?? null,
          items: { createMany: { data: items } },
        },
        include: { items: true },
      });

      if (movements.length > 0) {
        await tx.stockMovement.createMany({
          data: movements.map((m) => ({
            tenantId,
            productId: m.productId,
            userId,
            type: MovementType.SALE,
            delta: m.delta,
            refId: sale.id,
          })),
        });
      }

      return { sale, tracked };
    },
    { maxWait: 5000, timeout: 15000 },
  );

  // بعد نجاح الفاتورة: تحديث لحظي لباقي الأجهزة + تنبيه المخزون (مايأثرش على الرد)
  emitChange(tenantId, { entity: 'sales', action: 'created', id: sale.id, by: userId });
  if (tracked.length > 0) {
    emitChange(tenantId, { entity: 'products', action: 'stock', by: userId });
    void notifyLowStock(tenantId, tracked);
  }

  res.status(201).json(sale);
});

const listQuery = pageQuery(200)
  .merge(dateRangeQuery)
  .extend({
    customerId: z.string().optional(),
    userId: z.string().optional(),
    status: z.nativeEnum(SaleStatus).optional(),
  });

// الكاشير بيشوف فواتيره هو بس. المالك والمدير بيشوفوا الكل.
salesRouter.get('/', async (req, res) => {
  const { tenantId, userId, role } = ctx(req);
  if (role === 'STAFF') throw new HttpError(403, 'FORBIDDEN', 'مالكش صلاحية للعملية دي');
  const q = listQuery.parse(req.query);

  const where: Prisma.SaleWhereInput = {
    tenantId,
    ...(role === 'CASHIER' ? { userId } : q.userId ? { userId: q.userId } : {}),
    ...(q.customerId ? { customerId: q.customerId } : {}),
    ...(q.status ? { status: q.status } : {}),
    createdAt: rangeFilter(q.from, q.to),
  };

  const [items, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true } },
      },
      ...skipTake(q),
    }),
    prisma.sale.count({ where }),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
});

salesRouter.get('/:id', async (req, res) => {
  const { tenantId, userId, role } = ctx(req);
  if (role === 'STAFF') throw new HttpError(403, 'FORBIDDEN', 'مالكش صلاحية للعملية دي');
  const sale = await prisma.sale.findFirst({
    where: { id: idParam(req), tenantId, ...(role === 'CASHIER' ? { userId } : {}) },
    include: {
      items: true,
      user: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true, phone: true } },
    },
  });
  if (!sale) throw new HttpError(404, 'SALE_NOT_FOUND', 'الفاتورة غير موجودة');
  res.json(sale);
});

/**
 * إلغاء فاتورة (مش حذف): بتتعلّم VOIDED وبترجّع المخزون، وبتتشال من التقارير،
 * وبتفضل موجودة للمراجعة.
 */
salesRouter.post('/:id/void', requireRole('OWNER', 'MANAGER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const id = idParam(req);
  const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});

  await prisma.$transaction(async (tx) => {
    const sale = await tx.sale.findFirst({ where: { id, tenantId }, include: { items: true } });
    if (!sale) throw new HttpError(404, 'SALE_NOT_FOUND', 'الفاتورة غير موجودة');

    // قلب الحالة بشرط إنها لسه COMPLETED، فمستحيل تتلغي مرتين
    const flip = await tx.sale.updateMany({
      where: { id, tenantId, status: SaleStatus.COMPLETED },
      data: { status: SaleStatus.VOIDED, voidedAt: new Date(), voidReason: reason ?? null },
    });
    if (flip.count !== 1) throw new HttpError(409, 'ALREADY_VOIDED', 'الفاتورة دي ملغية بالفعل');

    const lines = [...sale.items].sort((a, b) => (a.productId ?? '').localeCompare(b.productId ?? ''));
    const movements: Prisma.StockMovementCreateManyInput[] = [];
    for (const it of lines) {
      if (!it.productId) continue;
      const r = await tx.product.updateMany({
        where: { id: it.productId, tenantId, trackStock: true },
        data: { qty: { increment: it.qty } },
      });
      if (r.count > 0) {
        movements.push({
          tenantId,
          productId: it.productId,
          userId,
          type: MovementType.VOID,
          delta: it.qty,
          refId: id,
        });
      }
    }
    if (movements.length > 0) await tx.stockMovement.createMany({ data: movements });
  });

  emitChange(tenantId, { entity: 'sales', action: 'voided', id, by: userId });
  emitChange(tenantId, { entity: 'products', action: 'stock', by: userId });
  res.json({ ok: true });
});
