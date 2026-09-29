import type { Page } from '@/types/page';

import SiteSettings from '@/components/dash/settings';

const SiteSettingsPage: Page = () => <SiteSettings />;
SiteSettingsPage.title = 'إعدادات الموقع';

export default SiteSettingsPage;
