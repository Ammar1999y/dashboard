import type { StoredRow } from './api';
import type { CreateCategoryOutput } from '@/utils/validation/categories';

/** Served by the mocks only until the back-end has it. */
export type CategoryClient = CreateCategoryOutput & StoredRow;
