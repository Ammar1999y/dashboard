import { fieldDocs } from '../api/field-docs';
import { preferencesSchema } from './preferences';

export const docs = [
  fieldDocs(preferencesSchema, {
    preset:
      'A theme preset the client resolves. It falls back to its built-in theme for one it does not know, so this server does not hold the list.',
  }),
];
