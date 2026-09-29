import { memo } from 'react';

import { Icon } from '@/components/ui/icon';
import { LabelTooltip } from '@/components/ui/tooltip';
import { DialogToggle } from '@/components/dialogs/dialog-toggle';
import { themeCustomizerDialog } from '@/components/theme-customizer/store';

export const SettingsButton = memo(() => (
  <LabelTooltip label='تخصيص شكل الواجهة'>
    <DialogToggle dialog={themeCustomizerDialog} variant='ghost' size='icon'>
      <Icon
        icon='solar:settings-bold-duotone'
        className='size-6 animate-slow-spin'
      />
    </DialogToggle>
  </LabelTooltip>
));
SettingsButton.displayName = 'SettingsButton';
