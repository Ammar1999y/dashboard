import { fieldDocs, schemaDocs } from '../api/field-docs';
import { ROLE_DESCRIPTION_MAX, ROLE_NAME_MAX } from './constants';
import {
  adminUpdatePermissionBodySchema,
  createPermissionSchema,
  permissionsArraySchema,
  roleDescriptionSchema,
} from './permissions';
import {
  STRICT_SINGLE_LINE_DESCRIPTION,
  STRICT_TEXT_DESCRIPTION,
  strictTextMaximum,
} from './rules.docs';

const ROLE_DESCRIPTION = `${STRICT_TEXT_DESCRIPTION}. ${strictTextMaximum(ROLE_DESCRIPTION_MAX)}`;

const MATRIX_RULES =
  'Page names must be unique. Unsupported actions may be omitted or false, never true.';

export const docs = [
  fieldDocs(createPermissionSchema, {
    roleName: `${STRICT_SINGLE_LINE_DESCRIPTION} ${strictTextMaximum(ROLE_NAME_MAX)}`,
    description: ROLE_DESCRIPTION,
    permissions: MATRIX_RULES,
    isActive: 'Users holding an inactive role cannot sign in.',
  }),
  fieldDocs(adminUpdatePermissionBodySchema, {
    permissions: `${MATRIX_RULES} The COMPLETE matrix: it REPLACES the stored one, so a page omitted from the array has its grants revoked. Omit the key to leave the stored matrix unchanged; an empty array is refused.`,
  }),
  schemaDocs(permissionsArraySchema, MATRIX_RULES),
  // On the preprocess too, where a reader of the bare field looks for it.
  schemaDocs(roleDescriptionSchema, ROLE_DESCRIPTION),
];
