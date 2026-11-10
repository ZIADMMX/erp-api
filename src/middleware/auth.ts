import type { RequestHandler, Request } from 'express';
import type { Role } from '@prisma/client';
import { HttpError } from '../errors';
import { verifyAccessToken } from '../tokens';

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * بيتأكد من التوكن. الـ tenantId والـ role بيجوا من التوكن بس،
 * مش من أي حاجة العميل يبعتها، وده اللي بيمنع أي منشأة تشوف بيانات منشأة تانية.
 * (لو اتعطّل مستخدم، صلاحيته بتنتهي بانتهاء الـ Access Token القصير، ومابيقدرش يجدد.)
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHORIZED', 'لازم تسجل دخول');
  }
  try {
    const p = verifyAccessToken(header.slice(7));
    req.auth = { userId: p.sub, tenantId: p.tid, role: p.role };
  } catch {
    throw new HttpError(401, 'TOKEN_INVALID', 'الجلسة انتهت، سجّل دخول تاني');
  }
  next();
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'مالكش صلاحية للعملية دي');
    }
    next();
  };

/** بيرجّع سياق المستخدم الحالي (بعد requireAuth) */
export function ctx(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, 'UNAUTHORIZED', 'لازم تسجل دخول');
  return req.auth;
}
