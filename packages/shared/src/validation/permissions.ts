import type { PermissionAction } from '../permissions/constants';

import * as z from 'zod';

import {
  DASHBOARD_PAGE_NAMES,
  getAvailablePermissions,
  PERMISSION_ACTIONS,
} from '../permissions/constants';
import {
  PERMISSIONS_ARRAY_MAX,
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
  ROLE_NAME_MIN,
} from './constants';
import {
  sanitizeStrict,
  sanitizeStrictSingleLine,
  STRICT_SINGLE_LINE_DESCRIPTION,
  STRICT_TEXT_DESCRIPTION,
  strictTextMaximum,
} from './rules';

const ERROR_MESSAGES = {
  roleNameMaxLength: `اسم الدور يجب أن لا يتجاوز ${ROLE_NAME_MAX} حرفاً`,
  descriptionMaxLength: `الوصف يجب أن لا يتجاوز ${ROLE_DESCRIPTION_MAX} حرفاً`,
  pageNameRequired: 'اسم الصفحة مطلوب',
  roleNameRequired: 'اسم الدور مطلوب',
  descriptionRequired: 'الوصف مطلوب',
  pagePermissionRequired: 'الصلاحيات مطلوبه',
  permissionsMaxLength: `عدد الصلاحيات يجب أن لا يتجاوز ${PERMISSIONS_ARRAY_MAX} صلاحيات`,
  permissionsRequired: 'الصلاحيات مطلوبه',
  duplicatePageNames: 'أسماء الصفحات يجب أن لا تتكرر',
  viewRequiredForWrite:
    'يجب تفعيل صلاحية العرض عند تفعيل أي صلاحية كتابة (إنشاء، تعديل، حذف)',
};

// `.strict()`, so a misspelled `dleete` is a 422 rather than a grant silently
// never written. Real but unavailable actions are handled by value in
// `normalizeActionsForPage`.
const permissionSchema = z
  .object(
    Object.keys(PERMISSION_ACTIONS).reduce(
      (acc, action) => {
        acc[action as PermissionAction] = z.boolean();
        return acc;
      },
      {} as Record<PermissionAction, z.ZodBoolean>
    )
  )
  .partial()
  .strict();

/**
 * ⚠️ The RAW wire shape, validated before anything is rebuilt: normalizing first
 * would hand `.strict()` the rebuilt object, so `{ name, permissionz: {...} }`
 * would pass as an empty matrix — which the update handler writes, pruning the
 * role's other pages.
 */
const rawPagePermissionSchema = z
  .object({
    name: z.enum(DASHBOARD_PAGE_NAMES),
    // Required and non-nullable: an absent or null matrix is ambiguous between
    // "no permissions" and "field forgotten", and the destructive reading wins.
    permissions: permissionSchema,
  })
  .strict();

/**
 * An action the page does not offer: 422 when granted, dropped when not.
 * Rejecting `edit: false` would fail a uniform matrix over a no-op, and
 * `sanitizePermissions` forces unavailable actions to false on read anyway.
 */
function normalizeActionsForPage(
  value: z.output<typeof rawPagePermissionSchema>,
  ctx: z.RefinementCtx
): z.output<typeof rawPagePermissionSchema> {
  const { name, permissions } = value;
  const available = getAvailablePermissions(name);
  // Safe to write by key: `permissionSchema` is `.strict()` over
  // `PERMISSION_ACTIONS`, so every surviving key is one of ours.
  const kept: Partial<Record<PermissionAction, boolean>> = {};

  for (const [action, granted] of Object.entries(permissions)) {
    if (available.includes(action as PermissionAction)) {
      kept[action as PermissionAction] = granted;
      continue;
    }
    if (granted !== true) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['permissions', action],
      message: `الصلاحية "${action}" غير متاحة لصفحة "${name}"`,
    });
  }

  return { name, permissions: kept };
}

export const pagePermissionSchema = rawPagePermissionSchema
  .transform(normalizeActionsForPage)
  .superRefine(({ permissions }, ctx) => {
    // `create` alone needs no read access (per product spec).
    // `edit`/`delete`/`publish` (all-scope) require `view`.
    // `editOwn`/`deleteOwn` require `view` OR `viewOwn`.
    const hasAllWrite =
      permissions.edit === true ||
      permissions.delete === true ||
      permissions.publish === true;

    if (hasAllWrite && permissions.view !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'view'],
        message: ERROR_MESSAGES.viewRequiredForWrite,
      });
      return;
    }

    if (
      (permissions.editOwn === true || permissions.deleteOwn === true) &&
      permissions.view !== true &&
      permissions.viewOwn !== true
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'viewOwn'],
        message: ERROR_MESSAGES.viewRequiredForWrite,
      });
    }
  });

function noDuplicatePageNames(items: { name: string }[], ctx: z.RefinementCtx) {
  const names = items.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({
      code: 'custom',
      message: ERROR_MESSAGES.duplicatePageNames,
    });
  }
}

/**
 * Bounded because each page entry is an INSERT and an audit-payload entry. The
 * caller's own checks go first, so the published keywords keep their order.
 */
const pageMatrix = (array: z.ZodArray<typeof pagePermissionSchema>) =>
  array
    .max(PERMISSIONS_ARRAY_MAX, ERROR_MESSAGES.permissionsMaxLength)
    .superRefine(noDuplicatePageNames);

export const permissionsArraySchema = pageMatrix(z.array(pagePermissionSchema));

export const createPermissionSchema = z.object({
  roleName: z.preprocess(
    sanitizeStrictSingleLine,
    z
      .string()
      .min(ROLE_NAME_MIN, ERROR_MESSAGES.roleNameRequired)
      .max(ROLE_NAME_MAX, ERROR_MESSAGES.roleNameMaxLength)
      .meta({
        maxLength: undefined,
        description: `${STRICT_SINGLE_LINE_DESCRIPTION} ${strictTextMaximum(ROLE_NAME_MAX)}`,
      })
  ),
  description: z
    .preprocess(
      sanitizeStrict,
      z
        .string()
        .max(ROLE_DESCRIPTION_MAX, ERROR_MESSAGES.descriptionMaxLength)
        .meta({
          maxLength: undefined,
          description: `${STRICT_TEXT_DESCRIPTION}. ${strictTextMaximum(ROLE_DESCRIPTION_MAX)}`,
        })
        .optional()
        .nullish()
    )
    .optional()
    .nullish(),
  permissions: pageMatrix(
    z.array(pagePermissionSchema).min(1, ERROR_MESSAGES.permissionsRequired)
  ),
  isActive: z.boolean(),
});

/**
 * UPDATE rejects unknown top-level keys instead of stripping them, so a
 * misspelled `descriptionn` is a 422 rather than a 200 that changed nothing.
 *
 * CREATE stays lenient, matching `createUserSchema` — every field it writes is
 * required, so a misspelled key fails as a MISSING field rather than as a silent
 * no-op, and the endpoint's documented contract is that a client may post back a
 * response object carrying server-owned extras (`createdAt`, `usersCount`) and
 * have them stripped. Nested page/action objects are strict in both.
 *
 * Kept separate from `createPermissionSchema` rather than `.strict()` on it,
 * because that one doubles as a react-hook-form resolver whose state
 * legitimately carries those response-only fields.
 *
 * No `id`: the target is the path parameter, which the handler validates on its
 * own, so a body `id` is an unknown key and refused.
 */
export const adminUpdatePermissionBodySchema = createPermissionSchema
  .partial({ permissions: true })
  .strict();
