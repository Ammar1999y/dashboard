import type { ButtonProps } from '@/components/ui/button';
import type { DialogStore } from '@/lib/dialogs';

import { useCallback } from 'react';

import { Button } from '@/components/ui/button';

type DialogToggleProps = ButtonProps & { dialog: DialogStore<void> };

export function DialogToggle({ dialog, onClick, ...props }: DialogToggleProps) {
  const isOpen = dialog.useIsOpen();

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      // An `asChild` wrapper passes its own, such as the settings tooltip.
      onClick?.(event);
      if (isOpen) dialog.close();
      else dialog.open();
    },
    [dialog, isOpen, onClick]
  );

  return (
    <Button
      aria-haspopup='dialog'
      aria-expanded={isOpen}
      {...props}
      onClick={handleClick}
    />
  );
}
