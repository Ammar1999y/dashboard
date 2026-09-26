import { memo } from 'react';

import { Button } from '@/components/ui/button';

interface DateActionsProps {
  onCancel: () => void;
  onSave: () => void;
}

export const DateActions = memo(({ onCancel, onSave }: DateActionsProps) => (
  <div className='flex justify-end pb-2 ps-4 pt-4 space-x-2'>
    <Button onClick={onCancel} variant='ghost'>
      الغاء
    </Button>
    <Button onClick={onSave}>حفظ</Button>
  </div>
));

DateActions.displayName = 'DateActions';
