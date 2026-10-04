import type { FilterColumnSpecs } from './column-specs';

// Server-owned filter contracts: keys are the allowlist, and the type decides
// which operators and value shapes are accepted. `allowScanOnly` enables the
// "does not contain" operator, a guaranteed sequential scan that a
// dashboard-sized table affords; turn it off here first if the table grows.

export const USERS_FILTER_COLUMNS: FilterColumnSpecs = {
  name: { type: 'text', allowScanOnly: true },
  email: { type: 'text', allowScanOnly: true },
  isActive: { type: 'boolean' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};

export const PERMISSIONS_FILTER_COLUMNS: FilterColumnSpecs = {
  roleName: { type: 'text', allowScanOnly: true },
  description: { type: 'text', allowScanOnly: true },
  isActive: { type: 'boolean' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};
