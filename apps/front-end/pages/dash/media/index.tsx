import type { Page } from '@/types/page';

import { DASHBOARD_PAGE_LABELS } from '@app/shared/messages/permissions';

import MediaLibrary from '@/components/dash/media';

const MediaPage: Page = () => <MediaLibrary />;
MediaPage.title = DASHBOARD_PAGE_LABELS.media;
MediaPage.fullBleed = true;

export default MediaPage;
