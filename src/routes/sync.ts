import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { idParam } from '../utils';
import { ctx, requireAuth, requireRole } from '../middleware/auth';
import { emitChange } from '../realtime';
import { validateBatch } from '../syncBatch';
import { hashToken } from '../tokens';

const KEY = /^fsk_[A-Za-z0-9_-]{43}$/;

// ---- الرفع من الديسك توب (مفتاح الجهاز، مش JWT) ----
export const syncPushRouter = Router();

syncPushRouter.post('/push', async (req, res) => {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  if (!match || !KEY.test(match[1])) throw new HttpError(401, 'DEVICE_KEY_INVALID', 'مفتاح الجهاز غير صالح');

  const batch = validateBatch(req.body);
  const rows = batch.filter((r) => !r.deleted);
  const gone = batch.filter((r) => r.deleted);

  const device = await prisma.syncDevice.findFirst({
    where: { keyHash: hashToken(match[1]), revokedAt: null },
    select: { id: true, tenantId: true },
  });
  if (!device) throw new HttpError(401, 'DEVICE_KEY_INVALID', 'مفتاح الجهاز غير صالح أو متوقف');

  // جملة واحدة للدفعة كلها؛ النسخة الأقدم عمرها ما تكتب فوق الأحدث
  if (rows.length > 0) await prisma.$executeRaw`
    INSERT INTO "SyncRecord" ("deviceId", "tenantId", "tableName", "uuid", "updatedAt", "data")
    SELECT ${device.id}, ${device.tenantId}, t.table_name, t.uuid, t.updated_at, t.data
    FROM unnest(
      ${rows.map((r) => r.table)}::text[],
      ${rows.map((r) => r.uuid)}::uuid[],
      ${rows.map((r) => r.updatedAt)}::timestamptz[],
      ${rows.map((r) => JSON.stringify(r.data))}::jsonb[]
    ) AS t(table_name, uuid, updated_at, data)
    ON CONFLICT ("deviceId", "tableName", "uuid") DO UPDATE
      SET "data" = EXCLUDED."data", "updatedAt" = EXCLUDED."updatedAt", "receivedAt" = CURRENT_TIMESTAMP
      WHERE "SyncRecord"."updatedAt" <= EXCLUDED."updatedAt"`;

  // الصفوف اللي اتمسحت على الديسك توب بتتمسح هنا، إلا لو عندنا نسخة أحدث من المسح
  if (gone.length > 0) await prisma.$executeRaw`
    DELETE FROM "SyncRecord" r
    USING unnest(
      ${gone.map((r) => r.table)}::text[],
      ${gone.map((r) => r.uuid)}::uuid[],
      ${gone.map((r) => r.updatedAt)}::timestamptz[]
    ) AS t(table_name, uuid, updated_at)
    WHERE r."deviceId" = ${device.id} AND r."tableName" = t.table_name AND r.uuid = t.uuid
      AND r."updatedAt" <= t.updated_at`;

  await prisma.syncDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
  emitChange(device.tenantId, { entity: 'sync', action: 'updated' });
  res.json({ ok: true, accepted: batch.length });
});

// ---- إدارة أجهزة الديسك توب (المالك بس) ----
export const syncDevicesRouter = Router();
syncDevicesRouter.use(requireAuth, requireRole('OWNER'));

syncDevicesRouter.get('/', async (req, res) => {
  const { tenantId } = ctx(req);
  const devices = await prisma.syncDevice.findMany({
    where: { tenantId },
    select: { id: true, name: true, createdAt: true, lastSeenAt: true, revokedAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(devices);
});

// المفتاح بيرجع مرة واحدة بس، والسيرفر بيحتفظ ببصمته
syncDevicesRouter.post('/', async (req, res) => {
  const { tenantId } = ctx(req);
  const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
  const key = `fsk_${crypto.randomBytes(32).toString('base64url')}`;
  const device = await prisma.syncDevice.create({
    data: { tenantId, name, keyHash: hashToken(key) },
    select: { id: true, name: true, createdAt: true },
  });
  res.status(201).json({ ...device, key });
});

syncDevicesRouter.delete('/:id', async (req, res) => {
  const { tenantId } = ctx(req);
  const { count } = await prisma.syncDevice.updateMany({
    where: { id: idParam(req), tenantId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw new HttpError(404, 'NOT_FOUND', 'الجهاز غير موجود');
  res.status(204).end();
});
