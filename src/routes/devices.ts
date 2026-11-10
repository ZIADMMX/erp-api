import { Router } from 'express';
import { Expo } from 'expo-server-sdk';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { ctx, requireAuth } from '../middleware/auth';

export const devicesRouter = Router();
devicesRouter.use(requireAuth);

const tokenSchema = z.object({
  pushToken: z.string().min(10).max(300),
  platform: z.enum(['ios', 'android']).optional(),
});

// الموبايل يسجّل الـ Push Token بتاعه بعد تسجيل الدخول
devicesRouter.post('/', async (req, res) => {
  const { tenantId, userId } = ctx(req);
  const body = tokenSchema.parse(req.body);
  if (!Expo.isExpoPushToken(body.pushToken)) {
    throw new HttpError(400, 'INVALID_PUSH_TOKEN', 'Push Token غير صالح');
  }

  // نفس الجهاز لو اتسجل بحساب تاني، بيتنقل للحساب الحالي
  await prisma.device.upsert({
    where: { pushToken: body.pushToken },
    create: { tenantId, userId, pushToken: body.pushToken, platform: body.platform },
    update: { tenantId, userId, platform: body.platform },
  });
  res.status(204).end();
});

// عند تسجيل الخروج من الموبايل
devicesRouter.post('/unregister', async (req, res) => {
  const { userId } = ctx(req);
  const { pushToken } = z.object({ pushToken: z.string().min(10).max(300) }).parse(req.body);
  await prisma.device.deleteMany({ where: { pushToken, userId } });
  res.status(204).end();
});
