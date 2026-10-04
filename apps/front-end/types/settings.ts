import type { StoredRow } from './api';
import type { SettingsOutput } from '@/utils/validation/settings';

/** The site's settings row. Served by the mocks only until the back-end has it. */
export type SettingsClient = SettingsOutput & StoredRow;
