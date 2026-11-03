import type { ButtonProps } from '@/components/ui/button';
import type { ReactNode } from 'react';

import { useEffect } from 'react';

import { useFormState } from 'react-hook-form';
import { MSG_SUBMIT_AGAIN_IN } from '@/constants/messages';

import { useResendCooldown } from '@/hooks/use-resend-cooldown';
import { Button } from '@/components/ui/button';

import { useSubmitHold } from './store';

type SubmitButtonProps = Omit<ButtonProps, 'type'> & {
  children: ReactNode;
};

// This button and SubmitLabel are the only things that re-render while the form
// submits — see components/form/form.tsx. Neither is memoized: both exist
// to re-render on `isSubmitting`, and `children` defeats a shallow compare.
const SubmitButton = ({ children, disabled, ...rest }: SubmitButtonProps) => {
  const { isSubmitting } = useFormState();
  const holdUntil = useSubmitHold();
  const { secondsLeft, isCoolingDown, start } = useResendCooldown();

  useEffect(() => {
    if (holdUntil !== null) start((holdUntil - Date.now()) / 1000);
  }, [holdUntil, start]);

  return (
    <Button
      type='submit'
      disabled={disabled || isSubmitting || isCoolingDown}
      {...rest}
    >
      {isCoolingDown ? MSG_SUBMIT_AGAIN_IN(secondsLeft) : children}
    </Button>
  );
};

interface SubmitLabelProps {
  children: ReactNode;
  /** Shown in place of `children` while the submit handler runs. */
  pending: string;
}

/** For a submit button whose wording changes, but whose icon does not. */
const SubmitLabel = ({ children, pending }: SubmitLabelProps) => {
  const { isSubmitting } = useFormState();
  return <>{isSubmitting ? pending : children}</>;
};

export { SubmitLabel };
export default SubmitButton;
