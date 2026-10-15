import { fieldDocs } from '../api/field-docs';
import { storageHealthQuerySchema } from './health';

export const docs = [
  fieldDocs(storageHealthQuerySchema, {
    deep: 'Set to 1 to run SQLite integrity and write probes. Other values use the cheap probe.',
  }),
];
