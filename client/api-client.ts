/**
 * عميل API جاهز للديسك توب (Electron) والموبايل (React Native) والويب.
 * انسخ الملف ده في كل تطبيق (أو حطه في package مشترك لو عندك Monorepo).
 *
 * بيعمل: تسجيل الدخول، تخزين الجلسة (عن طريق storage اللي إنت بتديهوله)،
 * وتجديد التوكن تلقائيًا لما ينتهي (من غير ما المستخدم يحس).
 */

export interface Session {
  accessToken: string;
  refreshToken: string;
}

/** حدّد مكان تخزين التوكن حسب التطبيق:
 *  - React Native: expo-secure-store
 *  - Electron: safeStorage (من الـ main process عن طريق IPC)
 *  - الويب: localStorage (أو الأفضل HttpOnly cookie لو عملت كده في السيرفر) */
export interface SessionStorage {
  get(): Promise<Session | null>;
  set(session: Session): Promise<void>;
  clear(): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface LoginResult {
  user: { id: string; name: string; email: string; role: string; tenantId: string };
  tenant: { id: string; name: string; businessType: string; modules: string[] };
  accessToken: string;
  refreshToken: string;
}

export function createApiClient(opts: {
  baseUrl: string; // مثال: https://my-api.onrender.com
  storage: SessionStorage;
  onSessionExpired?: () => void; // اعرض شاشة تسجيل الدخول
}) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  let refreshing: Promise<Session | null> | null = null;

  function buildUrl(path: string, query?: Query) {
    const qs = Object.entries(query ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  // أكتر من طلب ممكن يفشل في نفس اللحظة، فبنعمل تجديد واحد بس ونشاركه
  function refresh(): Promise<Session | null> {
    if (!refreshing) {
      refreshing = (async () => {
        const current = await opts.storage.get();
        if (!current) return null;
        const res = await fetch(`${baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
        if (!res.ok) {
          await opts.storage.clear();
          opts.onSessionExpired?.();
          return null;
        }
        const data = await res.json();
        const next: Session = { accessToken: data.accessToken, refreshToken: data.refreshToken };
        await opts.storage.set(next);
        return next;
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function request<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Query } = {},
    retry = true,
  ): Promise<T> {
    const session = await opts.storage.get();
    const res = await fetch(buildUrl(path, init.query), {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    // التوكن خلص: جدّد مرة واحدة وأعد الطلب
    if (res.status === 401 && retry && session) {
      const next = await refresh();
      if (next) return request<T>(path, init, false);
    }

    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? 'حصل خطأ');
    }
    return data as T;
  }

  return {
    request,
    get: <T>(path: string, query?: Query) => request<T>(path, { query }),
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
    patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
    delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

    async login(email: string, password: string) {
      const data = await request<LoginResult>('/auth/login', { method: 'POST', body: { email, password } }, false);
      await opts.storage.set({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      return data;
    },

    async register(input: {
      businessName: string;
      businessType?: string;
      name: string;
      email: string;
      password: string;
    }) {
      const data = await request<LoginResult>('/auth/register', { method: 'POST', body: input }, false);
      await opts.storage.set({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      return data;
    },

    async logout() {
      const session = await opts.storage.get();
      if (session) {
        await request('/auth/logout', { method: 'POST', body: { refreshToken: session.refreshToken } }, false).catch(
          () => undefined,
        );
      }
      await opts.storage.clear();
    },

    /** للـ Socket.io: التوكن الحالي */
    async getAccessToken() {
      return (await opts.storage.get())?.accessToken ?? null;
    },
  };
}
