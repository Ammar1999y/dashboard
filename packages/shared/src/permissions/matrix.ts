import type {
  DashboardPage,
  PermissionAction,
  PermissionObject,
} from './constants';

import {
  DASHBOARD_PAGE_NAMES,
  DEFAULT_PAGE_PERMISSIONS,
  getAvailablePermissions,
  PERMISSION_ACTION_NAMES,
} from './constants';

/** `role_permissions` rows as read or submitted; `permissions` is unverified. */
export type PermissionRows = Array<{ pageName: string; permissions: unknown }>;

/** A matrix as the request and response bodies key it: by page `name`. */
export type PagePermissions = Array<{
  name: DashboardPage;
  permissions: Record<string, boolean>;
}>;

export function toPermissionRows<P>(
  pages: ReadonlyArray<{ name: DashboardPage; permissions: P }>
): Array<{ pageName: DashboardPage; permissions: P }> {
  return pages.map((p) => ({ pageName: p.name, permissions: p.permissions }));
}

export function toPagePermissions<N extends string, P>(
  rows: ReadonlyArray<{ pageName: N; permissions: P }>
): Array<{ name: N; permissions: P }> {
  return rows.map((p) => ({ name: p.pageName, permissions: p.permissions }));
}

function isValidDashboardPage(page: string): page is DashboardPage {
  // Not `in` on an object: it admits `constructor`/`__proto__`, and
  // `sanitized[pageName] =` below would then set the prototype, not a key.
  return (DASHBOARD_PAGE_NAMES as readonly string[]).includes(page);
}

const ALL_ACTIONS = PERMISSION_ACTION_NAMES;

/**
 * Unknown pages are dropped; every action is present, `true` only where the
 * page offers it and the row grants it.
 */
export function sanitizePermissions(
  rolePerms: PermissionRows
): Partial<PermissionObject> {
  const sanitized: Partial<PermissionObject> = {};

  for (const perm of rolePerms) {
    if (!isValidDashboardPage(perm.pageName)) continue;

    const availableActions = getAvailablePermissions(perm.pageName);

    const rawPerms = (perm.permissions || {}) as Record<string, unknown>;
    const pagePerms = {} as Record<PermissionAction, boolean>;

    for (const action of ALL_ACTIONS) {
      pagePerms[action] = availableActions.includes(action)
        ? rawPerms[action] === true
        : false;
    }

    sanitized[perm.pageName] = pagePerms;
  }

  return sanitized;
}

/**
 * Every dashboard page with every action, missing ones `false`, keyed in
 * `DEFAULT_PAGE_PERMISSIONS` × `PERMISSION_ACTION_NAMES` order whatever the input's.
 */
function normalizeFullPermissions(rolePerms: PermissionRows): PermissionObject {
  const sanitized = sanitizePermissions(rolePerms);
  const full = {} as PermissionObject;

  for (const page of DEFAULT_PAGE_PERMISSIONS) {
    const pagePerms = {} as Record<PermissionAction, boolean>;
    for (const action of ALL_ACTIONS)
      pagePerms[action] = sanitized[page.name]?.[action] === true;
    full[page.name] = pagePerms;
  }

  return full;
}

/**
 * Semantic equality. Normalises into the full dashboard-page matrix first so
 * ordering, missing pages, and missing actions can't produce false negatives.
 * The normalised key order is fixed, so the serialisations compare directly:
 * this runs in the browser too, where `toSorted` is newer than the targets.
 */
export function permissionsEqual(
  a: PermissionRows,
  b: PermissionRows
): boolean {
  return (
    JSON.stringify(normalizeFullPermissions(a)) ===
    JSON.stringify(normalizeFullPermissions(b))
  );
}

/**
 * List the `page.action` pairs that differ between two permission sets, in the
 * form `users.delete: false -> true`. Both sides are normalised to the full
 * dashboard matrix first so ordering and missing pages can't fake a change.
 */
export function diffPermissionMatrices(
  before: PermissionRows,
  after: PermissionRows
): string[] {
  const from = normalizeFullPermissions(before);
  const to = normalizeFullPermissions(after);
  const changed: string[] = [];

  for (const page of DEFAULT_PAGE_PERMISSIONS) {
    for (const action of ALL_ACTIONS) {
      const wasGranted = from[page.name]?.[action] === true;
      const isGranted = to[page.name]?.[action] === true;
      if (wasGranted !== isGranted)
        changed.push(`${page.name}.${action}: ${wasGranted} -> ${isGranted}`);
    }
  }

  return changed;
}
