import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from './config';

export const pageQuery = (maxLimit = 200) =>
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(maxLimit).default(Math.min(50, maxLimit)),
  });

export function skipTake(q: { page: number; limit: number }) {
  return { skip: (q.page - 1) * q.limit, take: q.limit };
}

export const dateRangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** لو العميل ماحددش فترة: آخر 30 يوم لحد دلوقتي */
export function resolveRange(q: { from?: Date; to?: Date }) {
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

export function rangeFilter(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const tzQuery = z
  .string()
  .refine(validTimeZone, 'منطقة زمنية غير صحيحة')
  .default(env.DEFAULT_TZ);

/** نص اختياري: السلسلة الفاضية بتتحول لـ null */
export const optStr = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish();
