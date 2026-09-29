import { memo } from 'react';

import { Icon } from '@/components/ui/icon';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { useEditorStore } from './store';

const STRETCH_HINT = 'تمديد المحتوى إلى كامل العرض';

const StretchToggle = memo(
  ({ containerStretch }: { containerStretch: boolean }) => {
    const setContainerStretch = useEditorStore((s) => s.setContainerStretch);

    return (
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-1'>
          <Label
            className='mb-0 font-medium'
            title='توسيع'
            htmlFor='container-stretch'
          />
          <Tooltip delayDuration={700} disableHoverableContent>
            <TooltipTrigger
              className='mt-1 cursor-default'
              aria-label={STRETCH_HINT}
            >
              <Icon
                icon='solar:question-circle-linear'
                className='size-4 opacity-60'
              />
            </TooltipTrigger>
            <TooltipContent>{STRETCH_HINT}</TooltipContent>
          </Tooltip>
        </div>
        <Switch
          id='container-stretch'
          checked={containerStretch}
          onCheckedChange={setContainerStretch}
        />
      </div>
    );
  }
);

StretchToggle.displayName = 'StretchToggle';

export { StretchToggle };
