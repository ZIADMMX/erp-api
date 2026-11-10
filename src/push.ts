import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import type { Role } from '@prisma/client';
import { prisma } from './db';

const expo = new Expo();

/**
 * بيبعت Push Notification لموبايلات مستخدمي المنشأة (حسب الدور).
 * بيشتغل والتطبيق مقفول لأن جوجل/أبل هما اللي بيوصّلوه.
 * أي فشل هنا مابيوقفش العملية الأصلية (بيتسجل بس).
 */
export async function notifyTenant(
  tenantId: string,
  roles: Role[],
  msg: { title: string; body: string; data?: Record<string, unknown> },
) {
  try {
    const devices = await prisma.device.findMany({
      where: { tenantId, user: { active: true, role: { in: roles } } },
      select: { pushToken: true },
    });

    const messages: ExpoPushMessage[] = devices
      .filter((d) => Expo.isExpoPushToken(d.pushToken))
      .map((d) => ({
        to: d.pushToken,
        sound: 'default',
        title: msg.title,
        body: msg.body,
        data: msg.data,
      }));
    if (messages.length === 0) return;

    const dead: string[] = [];
    for (const chunk of expo.chunkPushNotifications(messages)) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((t, i) => {
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
          dead.push(chunk[i].to as string);
        }
      });
    }

    // امسح التوكنز الميتة (تطبيق اتمسح أو جهاز اتغير)
    if (dead.length > 0) {
      await prisma.device.deleteMany({ where: { pushToken: { in: dead } } });
    }
  } catch (err) {
    console.error('push failed:', err);
  }
}
