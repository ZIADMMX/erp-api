/**
 * مثال: التحديث اللحظي بين الكاشيرات والموبايل.
 * محتاج:  npm i socket.io-client
 *
 * السيرفر بيبعت حدث واحد اسمه "change" كل ما حاجة تتغير في منشأتك.
 * التطبيق بيعيد جلب البيانات من الـ API (فالأرقام مصدرها السيرفر دايمًا).
 */
import { io } from 'socket.io-client';
import type { createApiClient } from './api-client';

interface ChangeEvent {
  entity: 'sales' | 'products' | 'customers' | 'expenses' | 'users' | 'sync';
  action: 'created' | 'updated' | 'deleted' | 'voided' | 'stock';
  id?: string;
  by?: string; // userId اللي عمل التغيير
}

export function connectRealtime(
  baseUrl: string,
  api: ReturnType<typeof createApiClient>,
  myUserId: string,
  onChange: (evt: ChangeEvent) => void,
) {
  const socket = io(baseUrl, {
    transports: ['websocket'],
    // دالة، عشان كل إعادة اتصال تاخد أحدث توكن بعد التجديد
    auth: (cb) => {
      void api.getAccessToken().then((token) => cb({ token }));
    },
    reconnection: true, // لازم، لأن Render المجاني بيقفل الاتصال لما السيرفر ينام
  });

  socket.on('change', (evt: ChangeEvent) => {
    if (evt.by === myUserId) return; // أنا اللي عملت التغيير، مش محتاج أحدّث
    onChange(evt);
  });

  return () => socket.disconnect();
}

// مع React Query مثلًا:
//   connectRealtime(API_URL, api, user.id, (evt) => queryClient.invalidateQueries({ queryKey: [evt.entity] }));
