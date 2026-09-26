import { entityKeys } from '@/utils/query-cache';

export const USERS_QUERY_KEYS = entityKeys('dash-users');

export const ROLES_QUERY_KEYS = {
  list: ['roles'],
};
