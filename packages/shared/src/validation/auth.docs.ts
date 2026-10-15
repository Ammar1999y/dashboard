import { fieldDocs } from '../api/field-docs';
import { createUserSchema } from './auth';
import { NAME_MAX } from './constants';
import {
  STRICT_SINGLE_LINE_DESCRIPTION,
  strictTextMaximum,
} from './rules.docs';

export const docs = [
  fieldDocs(createUserSchema, {
    name: `${STRICT_SINGLE_LINE_DESCRIPTION} ${strictTextMaximum(NAME_MAX)}`,
  }),
];
