import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { ctx, requireAuth, requireRole } from '../middleware/auth';
import { emitChange } from '../realtime';
import { dateRangeQuery, idParam, optStr, pageQuery, rangeFilter, skipTake } from '../utils';

export const expensesRouter = Router();
expensesRouter.use(requireAuth, requireRole('OWNER', 'MANAGER'));

const base = z.object({
  title: z.string().trim().min(1).max(200),
  amount: z.number().positive().max(1e9),
  category: optStr(100),
  note: optStr(500),
  date: z.coerce.date().optional(),
});

async function mustFind(tenantId: string, id: string) {
  const e = await prisma.expense.findFirst({ where: { id, tenantId } });
  if (!e) throw new HttpError(404, 'EXPENSE_NOT_FOUND', 'المصروف غير موجود');
  return e;
}

expensesRouter.get('/', async (req, res) => {
  const { tenantId } = ctx(req);
  const q = pageQuery(200)
    .merge(dateRangeQuery)
    .extend({ category: z.string().trim().optional() })
    .parse(req.query);

  const where = {
    tenantId,
    ...(q.category ? { category: q.category } : {}),
    date: rangeFilter(q.from, q.to),
  };

  const [items, total] = await Promise.all([
    prisma.expense.findMany({ where, orderBy: { date: 'desc' }, ...skipTake(q) }),
    prisma.expense.count({ where }),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
});

expensesRouter.post('/', async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const body = base.parse(req.body);
  const expense = await prisma.expense.create({ data: { ...body, tenantId } });
  emitChange(tenantId, { entity: 'expenses', action: 'created', id: expense.id, by: userId });
  res.status(201).json(expense);
});

expensesRouter.patch('/:id', async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const body = base.partial().parse(req.body);
  await mustFind(tenantId, idParam(req));
  const expense = await prisma.expense.update({ where: { id: idParam(req) }, data: body });
  emitChange(tenantId, { entity: 'expenses', action: 'updated', id: expense.id, by: userId });
  res.json(expense);
});

expensesRouter.delete('/:id', requireRole('OWNER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  await mustFind(tenantId, idParam(req));
  await prisma.expense.delete({ where: { id: idParam(req) } });
  emitChange(tenantId, { entity: 'expenses', action: 'deleted', id: idParam(req), by: userId });
  res.status(204).end();
});
