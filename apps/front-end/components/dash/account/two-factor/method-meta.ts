import type { EnrolledMethod } from '@/lib/account/schemas';

import {
  optionIcon,
  optionLabel,
} from '@/components/dash/auth/second-factor/options';

/** The sign-in challenge's vocabulary for the same methods: one name for each, wherever it is read. */
const asOption = (entry: EnrolledMethod) => ({
  ...entry,
  id: entry.method === 'otp' ? `otp:${entry.contactKind}` : entry.method,
});

export const methodLabel = (entry: EnrolledMethod) =>
  optionLabel(asOption(entry));

export const methodIcon = (entry: EnrolledMethod) =>
  optionIcon(asOption(entry));
