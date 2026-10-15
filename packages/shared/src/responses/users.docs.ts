import { fieldDocs } from '../api/field-docs';
import { storedPreferencesSchema } from './users';

export const docs = [
  fieldDocs(storedPreferencesSchema, {
    updatedAt:
      'Server-side write time. Null only when nothing has ever been saved, so a stored choice of the defaults is distinguishable from no choice.',
  }),
];
