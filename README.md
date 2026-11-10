# ERP API

سيرفر واحد (Node.js + Express + Prisma + PostgreSQL) بيخدم الديسك توب والموبايل والويب.
كل الحسابات (الأرباح والتقارير والمخزون) بتتم هنا، والتطبيقات بتعرض النتيجة بس.

```
الديسك توب (Electron) ─┐
الموبايل (React Native) ├──►  الـ API (Render)  ──►  PostgreSQL (Neon)
الويب (React)          ─┘            │
                                     └──► Socket.io (تحديث لحظي) + Expo Push (إشعارات)
```

## اللي فيه

- **Multi-tenant:** كل منشأة (محل / صالون / مكتب / شركة عقارات) ليها بياناتها، والـ `tenantId` بيجي من التوكن بس.
- **حسابات وصلاحيات:** مالك (OWNER) · مدير (MANAGER) · كاشير (CASHIER) · موظف (STAFF).
- **الجلسات:** Access Token قصير (15 دقيقة) + Refresh Token بيتجدد تلقائيًا.
- **المخزون:** خصم ذري (Atomic) فمستحيل كاشيرين يبيعوا آخر قطعة مرتين، وسجل لكل حركة.
- **الفواتير:** ترقيم تلقائي لكل منشأة، حساب السعر والتكلفة في السيرفر، بيع آجل، إلغاء فاتورة (Void) مع رجوع المخزون.
- **التقارير:** ملخص أرباح، مبيعات يوم بيوم، أكتر الأصناف ربحًا، أداء الموظفين، قيمة المخزون.
- **الإشعارات:** تنبيه المخزون للمالك والمدير على الموبايل حتى والتطبيق مقفول (Expo Push).
- **Socket.io:** كل جهاز في المنشأة بيتحدث لحظيًا.
- **الموديولات حسب النشاط:** `modules` في المنشأة بتحدد اللي يظهر في التطبيق (حلاق / محامي / عقارات...).

## التشغيل على جهازك

محتاج Node.js 20 أو أحدث.

```bash
cd erp-api
npm install
cp .env.example .env        # على ويندوز: copy .env.example .env
```

افتح `.env` وعبّي 3 قيم:

1. **`DATABASE_URL`**: من Neon اضغط **Connect**، شغّل **Connection pooling**، وانسخ الرابط.
2. **`DIRECT_URL`**: نفس الرابط بعد ما توقف **Connection pooling** (الـ host من غير `-pooler`).
3. **`JWT_SECRET`**: ولّده بالأمر ده وحطه:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

بعدين:

```bash
npx prisma generate
npx prisma migrate dev --name init     # بيعمل الجداول في Neon
npm run dev                            # السيرفر على http://localhost:3000
```

افتح `http://localhost:3000/health/db`، لو ظهر `{"ok":true,"db":true}` يبقى الاتصال بالداتابيز تمام.

> **مهم:** فولدر `prisma/migrations` اللي بيتعمل بعد الأمر ده لازم يترفع على GitHub، لأن Render بيشغّله وقت النشر.

## تجربة سريعة (Thunder Client أو Postman)

**1) تسجيل منشأة جديدة** `POST /auth/register`
```json
{
  "businessName": "صالون النور",
  "businessType": "SALON",
  "name": "أحمد",
  "email": "owner@test.com",
  "password": "12345678"
}
```
هيرجّع `accessToken` و `refreshToken`. استخدم الـ accessToken في الهيدر: `Authorization: Bearer <token>`

**2) أضف صنف** `POST /products`
```json
{ "name": "شامبو", "cost": 40, "price": 70, "qty": 10, "minQty": 3 }
```

**3) اعمل فاتورة** `POST /sales`
```json
{ "items": [{ "productId": "ID_بتاع_الصنف", "qty": 2 }], "method": "CASH" }
```

**4) شوف الأرباح** `GET /reports/summary`

## الرفع: GitHub ثم Render

1. ارفع فولدر `erp-api` على GitHub (الـ `.env` متتجاهل تلقائيًا في `.gitignore`).
2. على Render: **New > Web Service** واختار الـ repo.
3. الإعدادات:
   - **Region:** Frankfurt (نفس منطقة Neon)
   - **Build Command:** `npm install --include=dev && npm run build && npx prisma migrate deploy`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
   - **Instance Type:** Free
4. من **Environment** ضيف: `DATABASE_URL` و `DIRECT_URL` و `JWT_SECRET` و `NODE_ENV=production`.
5. بعد النشر هتاخد رابط زي `https://erp-api.onrender.com`، وده اللي بتحطه في الديسك توب والموبايل.

لو الـ API جوه فولدر فرعي في الـ repo، ضيف **Root Directory** = اسم الفولدر.

## ربط الديسك توب والموبايل

انسخ `client/api-client.ts` في كل تطبيق:

```ts
import { createApiClient } from './api-client';

export const api = createApiClient({
  baseUrl: 'https://erp-api.onrender.com',
  storage: mySecureStorage,            // expo-secure-store في الموبايل، safeStorage في Electron
  onSessionExpired: () => goToLogin(),
});

await api.login('owner@test.com', '12345678');
const summary = await api.get('/reports/summary', { from: '2026-11-01T00:00:00+02:00' });
```

التحديث اللحظي: `client/realtime-example.ts`.

### إشعارات الموبايل (Expo)

بعد تسجيل الدخول في تطبيق الموبايل:
```ts
import * as Notifications from 'expo-notifications';
const { status } = await Notifications.requestPermissionsAsync();
if (status === 'granted') {
  const { data: pushToken } = await Notifications.getExpoPushTokenAsync();
  await api.post('/devices', { pushToken, platform: 'android' });
}
```
وعند تسجيل الخروج: `api.post('/devices/unregister', { pushToken })`.
الإشعارات البعيدة مش بتشتغل في Expo Go، محتاج Development Build. وآيفون محتاج حساب Apple Developer.

## الـ Endpoints

| المسار | الوصف | مين يقدر |
|---|---|---|
| `POST /auth/register` | منشأة جديدة + مالك | الكل |
| `POST /auth/login` · `/refresh` · `/logout` | الجلسة | الكل |
| `GET /auth/me` · `POST /auth/change-password` | حسابي | مسجّل دخول |
| `GET/POST/PATCH /users` | إدارة الموظفين | مالك (القراءة: + مدير) |
| `GET/POST/PATCH/DELETE /customers` | العملاء (CRM) | قراءة: الكل · كتابة: مالك/مدير/كاشير |
| `GET/POST/PATCH/DELETE /products` | الأصناف والخدمات | قراءة: الكل (من غير التكلفة للكاشير) · كتابة: مالك/مدير |
| `POST /products/:id/adjust` · `GET /products/:id/movements` | جرد وتسوية المخزون | مالك/مدير |
| `POST /sales` | فاتورة جديدة | مالك/مدير/كاشير |
| `GET /sales` · `GET /sales/:id` | الفواتير (الكاشير يشوف فواتيره بس) | مالك/مدير/كاشير |
| `POST /sales/:id/void` | إلغاء فاتورة | مالك/مدير |
| `GET/POST/PATCH/DELETE /expenses` | المصروفات | مالك/مدير (الحذف: مالك) |
| `GET /reports/summary` · `/daily` · `/top-products` · `/by-user` · `/inventory` | التقارير | مالك/مدير |
| `POST /devices` · `/devices/unregister` | تسجيل موبايل للإشعارات | مسجّل دخول |
| `GET /health` · `/health/db` | فحص السيرفر / الداتابيز | عام |

الأخطاء بتيجي بشكل موحد: `{ "error": { "code": "OUT_OF_STOCK", "message": "..." } }` والتطبيق يعتمد على `code`.
فلاتر التقارير: `from` و `to` بصيغة ISO (يفضل مع +02:00)، و `tz` للتجميع اليومي (الافتراضي `Africa/Cairo`).

## ملاحظات مهمة

- **Render المجاني بينام** بعد 15 دقيقة من غير استخدام، وأول طلب بعدها بياخد حتى دقيقة. الكاشير الفعلي محتاج خطة مدفوعة (حوالي 7 دولار).
- **Neon المجاني كمان بيوقف الحوسبة** وقت الخمول، فأول Query بعد فترة بتتأخر شوية. عشان كده `/health` مابيلمسش الداتابيز.
- **تجديد التوكن:** كل Refresh Token بيتستخدم مرة واحدة. `api-client.ts` بيجدد مرة واحدة حتى لو طلبات كتير فشلت مع بعض. لو كتبت عميلك بنفسك، ماتبعتش طلبي تجديد بنفس التوكن مع بعض.
- **الكميات أعداد صحيحة.** لو محتاج بيع بالوزن (كيلو/متر) محتاج تعديل في الـ schema.
- **المنطق الخاص بالحلاقين والمحامين والعقارات** (حجوزات، قضايا، جلسات، Leads، وحدات) لسه مش موجود. الـ `modules` جاهزة، والجداول بتتضاف على نفس النواة (عملاء / فواتير / موظفين / مصروفات).
- **خصم الكاشير:** حاليًا الكاشير يقدر يدّي أي خصم لحد إجمالي الفاتورة. لو عايز حد أقصى، ضيفه في `src/routes/sales.ts`.
- **بيانات الديسك توب القديمة (المحلية)** لو عندك عملاء فعليين محتاجة سكريبت نقل لمرة واحدة بيرفعها بـ `POST` على الـ endpoints دي.
