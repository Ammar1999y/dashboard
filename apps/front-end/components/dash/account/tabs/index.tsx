import type { FormTab } from '@/components/form/tabs/form-tabs';

import { TWO_FACTOR_ENABLED } from '@app/shared/validation/two-factor';

import { TwoFactorSection } from '../two-factor';
import { PasswordSection } from './password';
import { ProfileSection } from './profile';
import { SessionsSection } from './sessions';

// A route the deployment does not serve answers 404, so its tab is not offered.
const TWO_FACTOR_TABS: FormTab[] = TWO_FACTOR_ENABLED
  ? [{ id: 'twoFactor', label: 'التحقق بخطوتين', Panel: TwoFactorSection }]
  : [];

export const ACCOUNT_TABS: [FormTab, ...FormTab[]] = [
  { id: 'profile', label: 'الملف الشخصي', Panel: ProfileSection },
  { id: 'password', label: 'كلمة المرور', Panel: PasswordSection },
  ...TWO_FACTOR_TABS,
  { id: 'sessions', label: 'الجلسات', Panel: SessionsSection },
];
