import type { StoredRow } from './api';
import type { CreateSectionOutput } from '@/utils/validation/sections';

/** Served by the mocks only until the back-end has it. */
export type SectionClient = CreateSectionOutput & StoredRow;
