import { fieldDocs } from '../api/field-docs';
import { permissionDetailSchema, permissionRowsSchema } from './permissions';

export const docs = [
  fieldDocs(permissionRowsSchema.element, {
    roleName: 'Unique among roles.',
    description: 'Null when the role has none.',
    isActive:
      'Users holding an inactive role cannot sign in; deactivating a role revokes their sessions.',
    usersCount: 'Users holding this role, soft-deleted users excluded.',
  }),
  fieldDocs(permissionDetailSchema, {
    permissions:
      'One entry per dashboard page the role’s matrix lists, a page granting nothing included, holding the actions stored for it: an absent or false action is not granted, and an action the page does not offer is never stored.',
  }),
];
