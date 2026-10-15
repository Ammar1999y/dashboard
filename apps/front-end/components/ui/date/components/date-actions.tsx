import { memo } from 'react';

import { Button } from '@/components/ui/button';

interface DateActionsProps {
  onCancel: () => void;
  onSave: () => void;
}

export const DateActions = memo(({ onCancel, onSave }: DateActionsProps) => (
  <div className='flex justify-end gap-2 pb-2 ps-4 pt-4'>
    <Button onClick={onCancel} variant='ghost' className='text-sm'>
      الغاء
    </Button>
    <Button onClick={onSave} className='text-sm'>
      حفظ
    </Button>
  </div>
));

DateActions.displayName = 'DateActions';
