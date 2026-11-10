import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { corsOrigins, env } from './config';
import { prisma } from './db';
import { errorHandler, notFound } from './errors';
import { authRouter } from './routes/auth';
import { customersRouter } from './routes/customers';
import { devicesRouter } from './routes/devices';
import { expensesRouter } from './routes/expenses';
import { productsRouter } from './routes/products';
import { reportsRouter } from './routes/reports';
import { salesRouter } from './routes/sales';
import { usersRouter } from './routes/users';

export const app = express();

app.set('trust proxy', 1); // Render بيحط الـ API ورا Proxy
app.disable('x-powered-by');
app.use(helmet());

// الحماية الفعلية بالـ Token (Bearer) مش بالـ CORS. تطبيقات الموبايل والديسك توب
// مابتبعتش origin أو بتبعت "null"، فمسموح بيها. الويب لازم يكون في CORS_ORIGINS.
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed =
        !origin ||
        origin === 'null' ||
        env.NODE_ENV !== 'production' ||
        corsOrigins.includes('*') ||
        corsOrigins.includes(origin);
      cb(null, allowed);
    },
  }),
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }),
);
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({ name: 'erp-api', status: 'running' });
});

// Render بيسأل على /health باستمرار، فمفيش اتصال بالداتابيز هنا
// (عشان مايفضلش يصحّي Neon ويستهلك ساعات الحوسبة المجانية)
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// فحص يدوي لاتصال الداتابيز
app.get('/health/db', async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true, db: true });
});

app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/customers', customersRouter);
app.use('/products', productsRouter);
app.use('/sales', salesRouter);
app.use('/expenses', expensesRouter);
app.use('/reports', reportsRouter);
app.use('/devices', devicesRouter);

app.use(notFound);
app.use(errorHandler);
