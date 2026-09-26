export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  pageCount: number;
}

/** The response envelope every application endpoint returns. */
export interface ApiEnvelope<T = unknown> {
  success: boolean;
  message: string;
  code?: string;
  data: T;
  meta?: PaginationMeta;
}
