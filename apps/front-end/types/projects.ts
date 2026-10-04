import type { StoredRow } from './api';
import type { CreateProjectOutput } from '@/utils/validation/projects';

/** Served by the mocks only until the back-end has it. */
export type ProjectClient = CreateProjectOutput & StoredRow;
