import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL مطلوب'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET لازم يكون 32 حرف على الأقل'),
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).default(30),
  CORS_ORIGINS: z.string().default(''),
  DEFAULT_TZ: z.string().default('Africa/Cairo'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ إعدادات البيئة (.env) غير صحيحة:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
