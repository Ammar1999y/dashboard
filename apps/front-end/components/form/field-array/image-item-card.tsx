import type { FieldArrayItemProps } from '.';
import type { ReactNode } from 'react';

import { ACCEPT_IMAGES } from '@/lib/constants';

import { MAX_IMAGE_SIZE } from '@/utils/images/config';

import { FileUpload } from '@/components/file-upload';

import FormSwitch from '../form-switch';
import FieldArrayItemActions from './item-actions';

interface ImageItemCardProps extends FieldArrayItemProps {
  /** The row's `isActive` path. */
  statusName: string;
  statusAriaLabel: string;
  /** The row's fields. */
  children: ReactNode;
}

/** A field-array row: its fields beside a status toggle and one image. */
const ImageItemCard = ({
  index,
  onRemove,
  showDragHandle,
  statusName,
  statusAriaLabel,
  children,
}: ImageItemCardProps) => (
  <div className='rounded-lg border bg-card px-4 py-4 shadow-md'>
    <div className='flex flex-col-reverse gap-x-4 gap-y-5 md2:flex-row'>
      <div className='flex-1'>{children}</div>
      <div className='flex flex-[.7] flex-col space-y-2'>
        <FieldArrayItemActions
          index={index}
          onRemove={onRemove}
          showDragHandle={showDragHandle}
          className='pb-2'
        >
          <FormSwitch name={statusName} ariaLabel={statusAriaLabel} />
        </FieldArrayItemActions>
        <FileUpload
          maxFiles={1}
          maxSizeMB={MAX_IMAGE_SIZE}
          accept={ACCEPT_IMAGES}
          dropzoneText='اسحب وافلت الصورة هنا،'
          className='flex max-h-52 flex-1'
          dropzoneTextClassName='text-sm'
          dropzoneHelperText={`اقصى حجم للصورة ${MAX_IMAGE_SIZE}MB`}
        />
      </div>
    </div>
  </div>
);

export default ImageItemCard;
