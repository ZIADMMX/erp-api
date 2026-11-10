import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { BusinessType, type Role } from '@prisma/client';
import { z } from 'zod';
import { env } from '../config';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { ctx, requireAuth } from '../middleware/auth';
import { hashToken, newRefreshToken, signAccessToken } from '../tokens';

export const authRouter = Router();

// بيحسب بس المحاولات الفاشلة (عشان كاشيرات نفس المحل على نفس النت مايتحظروش)
const failedLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'محاولات كتير، استنى شوية وجرّب تاني' } },
});

// بنقارن بهاش وهمي لو الإيميل مش موجود، عشان زمن الرد مايكشفش وجود الحساب
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/** الموديولات المفعّلة تلقائيًا حسب نوع النشاط. التطبيقات تعرض اللي مفعّل بس. */
function defaultModules(type: BusinessType): string[] {
  const core = ['customers', 'expenses', 'reports'];
  switch (type) {
    case 'SALON':
    case 'BEAUTY':
      return [...core, 'services', 'appointments', 'commissions', 'inventory', 'sales'];
    case 'LAW':
      return [...core, 'cases', 'sessions', 'fees'];
    case 'REAL_ESTATE':
      return [...core, 'leads', 'units', 'deals'];
    default:
      return [...core, 'inventory', 'sales'];
  }
}

async function issueSession(user: { id: string; tenantId: string; role: Role }) {
  const rt = newRefreshToken();
  await prisma.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: rt.hash, expiresAt: rt.expiresAt },
  });
  return {
    accessToken: signAccessToken({ sub: user.id, tid: user.tenantId, role: user.role }),
    refreshToken: rt.token,
    expiresIn: env.ACCESS_TOKEN_MINUTES * 60,
  };
}

const publicUser = (u: { id: string; name: string; email: string; role: Role; tenantId: string }) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  tenantId: u.tenantId,
});

const publicTenant = (t: { id: string; name: string; businessType: BusinessType; modules: string[] }) => ({
  id: t.id,
  name: t.name,
  businessType: t.businessType,
  modules: t.modules,
});

// ---------- تسجيل منشأة جديدة (بيتعمل المالك معاها) ----------
const registerSchema = z.object({
  businessName: z.string().trim().min(2).max(100),
  businessType: z.nativeEnum(BusinessType).default(BusinessType.GENERAL),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, 'الباسورد 8 حروف على الأقل').max(100),
});

authRouter.post('/register', failedLoginLimiter, async (req, res) => {
  const body = registerSchema.parse(req.body);

  const exists = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } });
  if (exists) throw new HttpError(409, 'EMAIL_TAKEN', 'الإيميل ده مستخدم بالفعل');

  const passwordHash = await bcrypt.hash(body.password, 10);
  const tenant = await prisma.tenant.create({
    data: {
      name: body.businessName,
      businessType: body.businessType,
      modules: defaultModules(body.businessType),
      users: { create: { email: body.email, name: body.name, passwordHash, role: 'OWNER' } },
    },
    include: { users: true },
  });
  const user = tenant.users[0];

  res.status(201).json({
    user: publicUser(user),
    tenant: publicTenant(tenant),
    ...(await issueSession(user)),
  });
});

// ---------- تسجيل الدخول ----------
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(100),
});

authRouter.post('/login', failedLoginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email }, include: { tenant: true } });
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'INVALID_CREDENTIALS', 'الإيميل أو الباسورد غلط');
  if (!user.active) throw new HttpError(403, 'USER_DISABLED', 'الحساب ده موقوف، كلّم المالك');

  res.json({
    user: publicUser(user),
    tenant: publicTenant(user.tenant),
    ...(await issueSession(user)),
  });
});

// ---------- تجديد الجلسة (بيدّي توكن جديد ويلغي القديم) ----------
authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10).max(200) }).parse(req.body);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { user: true },
  });
  if (!stored || stored.expiresAt < new Date() || !stored.user.active) {
    if (stored) await prisma.refreshToken.deleteMany({ where: { id: stored.id } });
    throw new HttpError(401, 'REFRESH_INVALID', 'الجلسة انتهت، سجّل دخول تاني');
  }

  const next = newRefreshToken();
  await prisma.$transaction(async (tx) => {
    const del = await tx.refreshToken.deleteMany({ where: { id: stored.id } });
    if (del.count !== 1) throw new HttpError(401, 'REFRESH_INVALID', 'الجلسة انتهت، سجّل دخول تاني');
    await tx.refreshToken.create({
      data: { userId: stored.userId, tokenHash: next.hash, expiresAt: next.expiresAt },
    });
  });

  res.json({
    accessToken: signAccessToken({ sub: stored.user.id, tid: stored.user.tenantId, role: stored.user.role }),
    refreshToken: next.token,
    expiresIn: env.ACCESS_TOKEN_MINUTES * 60,
  });
});

// ---------- تسجيل الخروج ----------
authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().max(200).optional() }).parse(req.body ?? {});
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { tokenHash: hashToken(refreshToken) } });
  }
  res.status(204).end();
});

// ---------- بياناتي ----------
authRouter.get('/me', requireAuth, async (req, res) => {
  const { userId } = ctx(req);
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { tenant: true } });
  if (!user || !user.active) throw new HttpError(401, 'UNAUTHORIZED', 'لازم تسجل دخول');
  res.json({ user: publicUser(user), tenant: publicTenant(user.tenant) });
});

// ---------- تغيير الباسورد (بيقفل كل الجلسات القديمة) ----------
authRouter.post('/change-password', requireAuth, async (req, res) => {
  const { userId } = ctx(req);
  const body = z
    .object({ currentPassword: z.string().min(1).max(100), newPassword: z.string().min(8).max(100) })
    .parse(req.body);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'الباسورد الحالي غلط');
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(body.newPassword, 10) } }),
    prisma.refreshToken.deleteMany({ where: { userId } }),
  ]);

  res.json(await issueSession(user));
});
