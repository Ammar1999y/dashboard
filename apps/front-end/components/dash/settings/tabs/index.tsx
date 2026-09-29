import type { FormTab } from '@/components/form/tabs/form-tabs';

import { BasicInfoSection } from './basic';
import { ContactInfoSection } from './contact-info';
import { FontsSection } from './fonts';
import { ImagesSection } from './images';
import { NavLinksSection } from './nav-links';
import { SocialAccountsSection } from './social-accounts';

export const SETTINGS_TABS = [
  { id: 'basic', label: 'المعلومات الأساسية', Panel: BasicInfoSection },
  { id: 'images', label: 'الصور', Panel: ImagesSection },
  { id: 'fonts', label: 'الخطوط', Panel: FontsSection },
  {
    id: 'socialAccounts',
    label: 'حسابات التواصل',
    Panel: SocialAccountsSection,
  },
  { id: 'contactInfo', label: 'بيانات التواصل', Panel: ContactInfoSection },
  { id: 'navLinks', label: 'الروابط', Panel: NavLinksSection },
] as const satisfies readonly [FormTab, ...FormTab[]];
