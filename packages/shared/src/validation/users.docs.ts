import { fieldDocs } from '../api/field-docs';
import { NAME_MAX, NAME_MIN } from './constants';
import { STRICT_SINGLE_LINE_DESCRIPTION, strictTextLength } from './rules.docs';
import { createUserSchema } from './users';

export const docs = [
  fieldDocs(createUserSchema, {
    name: `${STRICT_SINGLE_LINE_DESCRIPTION} ${strictTextLength(NAME_MIN, NAME_MAX)}`,
  }),
];
