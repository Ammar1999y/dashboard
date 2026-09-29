import { memo } from 'react';

import { Label } from '@/components/ui/label';
import { FileUpload } from '@/components/shared/file-upload';

const ImagesSection = memo(() => {
  return (
    <div className='grid grid-cols-1 gap-8 md:grid-cols-2'>
      <div>
        <Label title='أيقونة الموقع الرئيسية' htmlFor='favicon-image' />
        <FileUpload
          maxFiles={1}
          inputId='favicon-image'
          dropzoneHelperText='أبعاد مُفضلة: 512×512 بكسل'
        />
      </div>

      <div>
        <Label title='أيقونة الموقع الكبيرة' htmlFor='site-icon-large' />
        <FileUpload maxFiles={1} inputId='site-icon-large' />
      </div>

      <div>
        <Label title='أيقونة الموقع الصغيرة' htmlFor='site-icon-small' />
        <FileUpload maxFiles={1} inputId='site-icon-small' />
      </div>

      <div className='flex flex-col'>
        <Label title='صورة OpenGraph' htmlFor='og-image' />
        <FileUpload
          maxFiles={1}
          inputId='og-image'
          dropzoneHelperText='أبعاد مُفضلة: 1200×630 بكسل'
        />
        <p className='mt-2 text-sm text-muted-foreground'>
          تظهر عند مشاركة الموقع على منصات التواصل الاجتماعي. الأبعاد المُفضلة:
          1200×630 بكسل.
        </p>
      </div>
    </div>
  );
});

ImagesSection.displayName = 'ImagesSection';

export { ImagesSection };
