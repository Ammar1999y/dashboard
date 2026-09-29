import { memo } from 'react';

import { Label } from '@/components/ui/label';
import { FileUpload } from '@/components/shared/file-upload';

const ImagesSection = memo(() => {
  return (
    <>
      <Label title='الصور' htmlFor='section-images' />
      <FileUpload maxFiles={30} inputId='section-images' />
    </>
  );
});
ImagesSection.displayName = 'ImagesSection';

export { ImagesSection };
