import type { PermissionAction } from '../permissions/constants';

import * as z from 'zod';

import { permissionValidationMsg } from '../messages/validation';
import {
  DASHBOARD_PAGE_NAMES,
  getAvailablePermissions,
  PERMISSION_ACTION_NAMES,
} from '../permissions/constants';
import {
  PERMISSIONS_ARRAY_MAX,
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
  ROLE_NAME_MIN,
} from './constants';
import { sanitizeStrict, sanitizeStrictSingleLine } from './rules';

/** "Any of `actions` granted" requires "any of `required` granted", in JSON Schema. */
function dependencyRule(
  actions: readonly PermissionAction[],
  required: readonly PermissionAction[]
) {
  const anyTrue = (names: readonly PermissionAction[]) => {
    const branches = names.map((action) => ({
      properties: { [action]: { const: true } },
      required: [action],
    }));
    return branches.length === 1 ? branches[0] : { anyOf: branches };
  };
  return {
    if: {
      properties: { permissions: anyTrue(actions) },
      required: ['permissions'],
    },
    // eslint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword
    then: { properties: { permissions: anyTrue(required) } },
  };
}

// `.strict()`, so a misspelled `dleete` is a 422 rather than a grant silently
// never written. Real but unavailable actions are handled by value in
// `normalizeActionsForPage`.
export const permissionSchema = z
  .object(
    PERMISSION_ACTION_NAMES.reduce(
      (acc, action) => {
        acc[action] = z.boolean();
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
  .strict()
  // The refinements below, as the document states them. Runtime
  // validation is the refinements'; this changes no parse.
  .meta({
    allOf: [
      dependencyRule(['edit', 'delete', 'publish'], ['view']),
      dependencyRule(['editOwn', 'deleteOwn'], ['view', 'viewOwn']),
      {
        if: { properties: { name: { const: 'home' } }, required: ['name'] },
        // eslint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword
        then: {
          properties: {
            permissions: {
              properties: Object.fromEntries(
                PERMISSION_ACTION_NAMES.filter(
                  (action) => action !== 'view'
                ).map((action) => [action, { const: false }])
              ),
            },
          },
        },
      },
    ],
  });

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
  // `PERMISSION_ACTION_NAMES`, so every surviving key is one of ours.
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
      message: permissionValidationMsg.actionUnavailableForPage(action, name),
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
        message: permissionValidationMsg.viewRequiredForWrite,
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
        message: permissionValidationMsg.viewRequiredForWrite,
      });
    }
  });

function noDuplicatePageNames(items: { name: string }[], ctx: z.RefinementCtx) {
  const names = items.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({
      code: 'custom',
      message: permissionValidationMsg.duplicatePageNames,
    });
  }
}

/**
 * Bounded because each page entry is an INSERT and an audit-payload entry. The
 * caller's own checks go first, so the published keywords keep their order.
 */
const pageMatrix = (array: z.ZodArray<typeof pagePermissionSchema>) =>
  array
    .max(PERMISSIONS_ARRAY_MAX, permissionValidationMsg.permissionsMaxLength)
    .superRefine(noDuplicatePageNames)
    .meta({ 'x-unique-by': 'name' });

export const permissionsArraySchema = pageMatrix(z.array(pagePermissionSchema));

export const roleDescriptionSchema = z.preprocess(
  sanitizeStrict,
  z
    .string()
    .max(ROLE_DESCRIPTION_MAX, permissionValidationMsg.descriptionMaxLength)
    .meta({ maxLength: undefined })
    .optional()
    .nullish()
);

export const createPermissionSchema = z.object({
  roleName: z.preprocess(
    sanitizeStrictSingleLine,
    z
      .string()
      .min(ROLE_NAME_MIN, permissionValidationMsg.roleNameRequired)
      .max(ROLE_NAME_MAX, permissionValidationMsg.roleNameMaxLength)
      .meta({ maxLength: undefined })
  ),
  description: roleDescriptionSchema.optional().nullish(),
  permissions: pageMatrix(
    z
      .array(pagePermissionSchema)
      .min(1, permissionValidationMsg.permissionsRequired)
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
