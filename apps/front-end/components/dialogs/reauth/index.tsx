import type { ReauthRequest } from '@/lib/auth/reauth';
import type { ReauthMethod } from '@app/shared/validation/reauth';

import { memo, useCallback, useEffect, useId, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import {
  MSG_LOADING,
  MSG_REAUTH_DESCRIPTION,
  MSG_REAUTH_NO_METHODS,
} from '@/constants/messages';
import { markProving, reauthDialog, settleReauth } from '@/lib/auth/reauth';
import {
  fetchReauthMethods,
  proveWithPasskey,
  proveWithPassword,
} from '@/lib/auth/reauth-proof';

import { useAsyncAction } from '@/hooks/use-async-action';
import { Button } from '@/components/ui/button';
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { StoreDialog } from '../store-dialog';

const METHODS_KEY = ['reauth', 'methods'];

const METHOD_LABELS = {
  password: 'كلمة المرور',
  passkey: 'مفتاح المرور',
} as const satisfies Record<ReauthMethod, string>;

interface ProofProps {
  disabled: boolean;
  onProve: (run: () => Promise<void>) => void;
}

const PasswordProof = memo(({ disabled, onProve }: ProofProps) => {
  const passwordId = useId();
  const [password, setPassword] = useState('');

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setPassword(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (password) onProve(() => proveWithPassword(password));
    },
    [onProve, password]
  );

  return (
    <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
      <div>
        <Label htmlFor={passwordId} title='كلمة المرور' />
        <Input
          id={passwordId}
          type='password'
          dir='ltr'
          autoComplete='current-password'
          autoFocus
          value={password}
          onChange={handleChange}
        />
      </div>
      <Button type='submit' disabled={disabled || !password}>
        {disabled ? 'جاري التأكيد...' : 'تأكيد'}
      </Button>
    </form>
  );
});
PasswordProof.displayName = 'PasswordProof';

const PasskeyProof = memo(({ disabled, onProve }: ProofProps) => {
  const handleClick = useCallback(() => onProve(proveWithPasskey), [onProve]);

  return (
    <Button onClick={handleClick} disabled={disabled} className='w-full'>
      <Icon icon='solar:key-square-2-bold-duotone' className='size-5' />
      {disabled ? 'بانتظار مفتاح المرور...' : 'التأكيد بمفتاح المرور'}
    </Button>
  );
});
PasskeyProof.displayName = 'PasskeyProof';

const Proof = memo(
  ({ method, ...props }: ProofProps & { method: ReauthMethod }) =>
    method === 'password' ? (
      <PasswordProof {...props} />
    ) : (
      <PasskeyProof {...props} />
    )
);
Proof.displayName = 'Proof';

interface ProofsProps extends ProofProps {
  methods: readonly ReauthMethod[];
}

/** One proof on its own, or a tab for each when the account has several. */
const Proofs = memo(({ methods, ...props }: ProofsProps) => {
  const [first] = methods;
  if (first === undefined)
    return (
      <p className='text-center text-sm text-muted-foreground'>
        {MSG_REAUTH_NO_METHODS}
      </p>
    );
  if (methods.length === 1) return <Proof method={first} {...props} />;

  return (
    <Tabs defaultValue={first} className='w-full'>
      <TabsList className='grid w-full grid-cols-2'>
        {methods.map((method) => (
          <TabsTrigger key={method} value={method} disabled={props.disabled}>
            {METHOD_LABELS[method]}
          </TabsTrigger>
        ))}
      </TabsList>
      {methods.map((method) => (
        <TabsContent key={method} value={method}>
          <Proof method={method} {...props} />
        </TabsContent>
      ))}
    </Tabs>
  );
});
Proofs.displayName = 'Proofs';

// Rendered inside the dialog content, which unmounts once the close animation
// ends: each opening starts from an empty form.
const ReauthBody = memo(({ request }: { request: ReauthRequest }) => {
  const query = useQuery({
    queryKey: METHODS_KEY,
    queryFn: ({ signal }) => fetchReauthMethods(signal),
    // The account may have gained or lost a passkey since the last prompt.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const prove = useCallback(
    async (run: () => Promise<void>) => {
      markProving(request, true);
      try {
        await run();
      } finally {
        markProving(request, false);
      }
    },
    [request]
  );
  const { pending: proving, run: runProof } = useAsyncAction(prove);

  const handleProve = useCallback(
    async (run: () => Promise<void>) => {
      if (await runProof(run)) settleReauth(request, true);
    },
    [request, runProof]
  );

  const handleCancel = useCallback(
    () => settleReauth(request, false),
    [request]
  );

  if (query.isPending) {
    return (
      <div className='flex flex-col items-center gap-2 py-6'>
        <Icon
          icon='lucide:loader-circle'
          className='size-8 animate-spin text-primary'
        />
        <p className='text-sm text-muted-foreground'>{MSG_LOADING}</p>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {query.isError ? (
        <ErrorState error={query.error} refetch={query.refetch} />
      ) : (
        <Proofs methods={query.data} disabled={proving} onProve={handleProve} />
      )}
      <Button variant='ghost' onClick={handleCancel} disabled={proving}>
        إلغاء
      </Button>
    </div>
  );
});
ReauthBody.displayName = 'ReauthBody';

const keepOpenWhileProving = (event: Event) => {
  if (reauthDialog.getPayload()?.proving) event.preventDefault();
};

/**
 * The prompt `requestReauth` opens, and the only place that settles it: any
 * close that does not come from a proof (Escape, a click outside, a page
 * change) answers "declined".
 */
export default function ReauthDialog() {
  const request = reauthDialog.usePayload();
  const isOpen = reauthDialog.useIsOpen();

  useEffect(() => {
    if (!isOpen && request) settleReauth(request, false);
  }, [isOpen, request]);

  return (
    <StoreDialog
      dialog={reauthDialog}
      className='sm:max-w-[425px]'
      onEscapeKeyDown={keepOpenWhileProving}
      onInteractOutside={keepOpenWhileProving}
    >
      <DialogHeader>
        <div className='flex items-center gap-2'>
          <div className='rounded-lg bg-primary/10 p-2'>
            <Icon icon='solar:key-square-2-bold-duotone' className='size-4' />
          </div>
          <DialogTitle className='text-lg'>تأكيد الهوية</DialogTitle>
        </div>
        <DialogDescription>{MSG_REAUTH_DESCRIPTION}</DialogDescription>
      </DialogHeader>
      <div className='px-4 pb-4'>
        {request && <ReauthBody key={request.id} request={request} />}
      </div>
    </StoreDialog>
  );
}
