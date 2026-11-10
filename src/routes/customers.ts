import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { ctx, requireAuth, requireRole } from '../middleware/auth';
import { emitChange } from '../realtime';
import { idParam, optStr, pageQuery, skipTake } from '../utils';

export const customersRouter = Router();
customersRouter.use(requireAuth);

const base = z.object({
  name: z.string().trim().min(1).max(200),
  phone: optStr(30),
  email: z.string().trim().email().max(200).nullish(),
  notes: optStr(1000),
});

async function mustFind(tenantId: string, id: string) {
  const c = await prisma.customer.findFirst({ where: { id, tenantId } });
  if (!c) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'العميل غير موجود');
  return c;
}

customersRouter.get('/', async (req, res) => {
  const { tenantId } = ctx(req);
  const q = pageQuery(200)
    .extend({ q: z.string().trim().optional() })
    .parse(req.query);

  const where: Prisma.CustomerWhereInput = {
    tenantId,
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { phone: { contains: q.q } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { name: 'asc' }, ...skipTake(q) }),
    prisma.customer.count({ where }),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
});

// بيانات العميل + إحصائيات مشترياته (مفيدة للـ CRM)
customersRouter.get('/:id', async (req, res) => {
  const { tenantId } = ctx(req);
  const customer = await mustFind(tenantId, idParam(req));
  const stats = await prisma.sale.aggregate({
    where: { tenantId, customerId: customer.id, status: 'COMPLETED' },
    _sum: { total: true },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  res.json({
    ...customer,
    stats: {
      salesCount: stats._count._all,
      totalSpent: stats._sum.total ?? 0,
      lastPurchaseAt: stats._max.createdAt,
    },
  });
});

customersRouter.post('/', requireRole('OWNER', 'MANAGER', 'CASHIER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const body = base.parse(req.body);
  const customer = await prisma.customer.create({ data: { ...body, tenantId } });
  emitChange(tenantId, { entity: 'customers', action: 'created', id: customer.id, by: userId });
  res.status(201).json(customer);
});

customersRouter.patch('/:id', requireRole('OWNER', 'MANAGER', 'CASHIER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const body = base.partial().parse(req.body);
  await mustFind(tenantId, idParam(req));
  const customer = await prisma.customer.update({ where: { id: idParam(req) }, data: body });
  emitChange(tenantId, { entity: 'customers', action: 'updated', id: customer.id, by: userId });
  res.json(customer);
});

// الحذف بيسيب فواتير العميل زي ما هي (بتبقى من غير اسم عميل)
customersRouter.delete('/:id', requireRole('OWNER', 'MANAGER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  await mustFind(tenantId, idParam(req));
  await prisma.customer.delete({ where: { id: idParam(req) } });
  emitChange(tenantId, { entity: 'customers', action: 'deleted', id: idParam(req), by: userId });
  res.status(204).end();
});
