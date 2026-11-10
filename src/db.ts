import { Prisma, PrismaClient } from '@prisma/client';
import { env } from './config';

// Prisma بترجّع الأرقام العشرية (Decimal) كنص في JSON.
// هنا بنخليها رقم عادي عشان التطبيقات تاخدها جاهزة.
// (الحسابات جوه السيرفر كلها بتتم بـ Decimal عشان مايحصلش أخطاء تقريب.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Prisma.Decimal.prototype as any).toJSON = function (this: Prisma.Decimal) {
  return this.toNumber();
};

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
