import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { verifyAccessToken } from './tokens';

let io: Server | null = null;

export interface ChangeEvent {
  entity: 'sales' | 'products' | 'customers' | 'expenses' | 'users' | 'sync';
  action: 'created' | 'updated' | 'deleted' | 'voided' | 'stock';
  id?: string;
  /** userId اللي عمل التغيير، عشان الجهاز نفسه يتجاهل الحدث لو عايز */
  by?: string;
}

/**
 * كل جهاز بيتصل بالتوكن بتاعه ويدخل "غرفة" المنشأة بتاعته بس.
 * الحدث بيقول "في حاجة اتغيرت"، والتطبيق يعيد جلب البيانات من الـ API،
 * فالأرقام مصدرها دايمًا السيرفر.
 */
export function initRealtime(server: HttpServer) {
  // الأمان هنا بالتوكن مش بالـ origin (مفيش cookies)
  io = new Server(server, { cors: { origin: true } });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') throw new Error('no token');
      const p = verifyAccessToken(token);
      socket.data.tenantId = p.tid;
      socket.data.userId = p.sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    void socket.join(`tenant:${socket.data.tenantId}`);
  });
}

export function emitChange(tenantId: string, evt: ChangeEvent) {
  io?.to(`tenant:${tenantId}`).emit('change', evt);
}
