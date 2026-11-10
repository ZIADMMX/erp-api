import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { ctx, requireAuth, requireRole } from '../middleware/auth';
import { emitChange } from '../realtime';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const userSelect = { id: true, name: true, email: true, role: true, active: true, createdAt: true } as const;

// قايمة الموظفين
usersRouter.get('/', requireRole('OWNER', 'MANAGER'), async (req, res) => {
  const { tenantId } = ctx(req);
  const items = await prisma.user.findMany({
    where: { tenantId },
    select: userSelect,
    orderBy: { createdAt: 'asc' },
  });
  res.json({ items });
});

// إضافة موظف (كاشير / مدير / موظف) — المالك بس
const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(100),
  role: z.enum(['MANAGER', 'CASHIER', 'STAFF']),
});

usersRouter.post('/', requireRole('OWNER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const body = createSchema.parse(req.body);

  const user = await prisma.user.create({
    data: {
      tenantId,
      name: body.name,
      email: body.email,
      role: body.role,
      passwordHash: await bcrypt.hash(body.password, 10),
    },
    select: userSelect,
  });

  emitChange(tenantId, { entity: 'users', action: 'created', id: user.id, by: userId });
  res.status(201).json(user);
});

// تعديل موظف / إيقافه / تغيير باسورده — المالك بس
const updateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  role: z.enum(['MANAGER', 'CASHIER', 'STAFF']).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(100).optional(),
});

usersRouter.patch('/:id', requireRole('OWNER'), async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const id = req.params.id;
  const body = updateSchema.parse(req.body);

  const target = await prisma.user.findFirst({ where: { id, tenantId } });
  if (!target) throw new HttpError(404, 'USER_NOT_FOUND', 'الموظف غير موجود');
  if (target.role === 'OWNER') {
    throw new HttpError(403, 'FORBIDDEN', 'مينفعش تعدّل حساب المالك من هنا');
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.password !== undefined ? { passwordHash: await bcrypt.hash(body.password, 10) } : {}),
    },
    select: userSelect,
  });

  // إيقاف الموظف أو تغيير باسورده بيقفل جلساته فورًا (مايقدرش يجدد التوكن)
  if (body.active === false || body.password !== undefined) {
    await prisma.refreshToken.deleteMany({ where: { userId: id } });
    await prisma.device.deleteMany({ where: { userId: id } });
  }

  emitChange(tenantId, { entity: 'users', action: 'updated', id, by: userId });
  res.json(user);
});
