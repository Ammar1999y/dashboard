import type { PaginationMeta } from '@/types/data-table';

import { HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';

/** The URL `apiFetch` and the auth client send `path` to. */
export const api = (path: string) => `${API_URL}${path}`;

/** The server's own wording, so a toast reads the same against either. */
export const MSG = {
  fetched: 'تم جلب البيانات بنجاح',
  created: 'تم الإنشاء بنجاح',
  updated: 'تم التحديث بنجاح',
  deleted: 'تم الحذف بنجاح',
  notFound: 'البيانات غير موجودة',
  invalidInput: 'قم بالتحقق من البيانات المدخله',
  emailExists: 'البريد الإلكتروني مستخدم بالفعل',
  forbidden: 'ليس لديك صلاحيه',
  loginRequired: 'قم بتسجيل الدخول اولا',
} as const;

export const ok = <T>(data: T, message: string = MSG.fetched) =>
  HttpResponse.json({ success: true, message, data });

export const okPage = <T>(page: { data: T[]; meta: PaginationMeta }) =>
  HttpResponse.json({ success: true, message: MSG.fetched, ...page });

export const fail = (status: number, message: string) =>
  HttpResponse.json({ success: false, message }, { status });

export const notFound = () => fail(404, MSG.notFound);

/**
 * A JSON object body, or `{}` for anything else. The fields are trusted to be
 * `T`'s: the only sender is this app's own zod-validated forms, and the real
 * server is where that contract is enforced.
 */
export async function readBody<T>(request: Request): Promise<Partial<T>> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Partial<T>)
      : {};
  } catch {
    return {};
  }
}
