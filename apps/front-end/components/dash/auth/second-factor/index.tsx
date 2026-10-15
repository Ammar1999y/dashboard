import type { TrustControl } from './code-panel';
import type { FactorOption } from './options';
import type { OtpSendState } from './otp-panel';

import { useCallback, useMemo, useState } from 'react';

import { MSG_TWO_FACTOR_RESTART_HINT } from '@/constants/messages';

import { Button } from '@/components/ui/button';

import { CodePanel } from './code-panel';
import { MethodList } from './method-list';
import { optionHint } from './options';
import { OtpPanel } from './otp-panel';
import { PasskeyPanel } from './passkey-panel';

const initialSendState = (options: readonly FactorOption[]) =>
  Object.fromEntries(
    options
      .filter(({ method }) => method === 'otp')
      .map((option): [string, OtpSendState] => {
        const wait = option.nextAllowedIn ?? 0;
        // A wait means a code went out a moment ago, and may still be good.
        return [
          option.id,
          { sent: wait > 0, availableAt: Date.now() + wait * 1000 },
        ];
      })
  );

interface SecondFactorProps {
  /** Non-empty, and only options this deployment still serves. */
  options: readonly FactorOption[];
  /** `null` asks: nothing is picked for a user who only has recovery material. */
  defaultMethod: string | null;
  /** Sends a code to an `otp` option; resolves the seconds before the next send. */
  sendCode: (option: FactorOption) => Promise<number>;
  verifyCode: (
    option: FactorOption,
    code: string,
    trustDevice: boolean
  ) => Promise<void>;
  /**
   * Runs the whole ceremony. Without it a passkey option is not offered, which
   * is the account-recovery case: the browser has no ceremony to run there.
   */
  verifyPasskey?: (trustDevice: boolean) => Promise<void>;
  /** Whether a verified device may be remembered. */
  offerTrust: boolean;
  submitLabel: string;
  pendingLabel: string;
  restartLabel: string;
  onRestart: () => void;
}

/**
 * The second-factor step, for the sign-in challenge and for account recovery:
 * lands on the default method, lets the user switch freely, and leaves the
 * server to count attempts, which every method shares.
 */
export default function SecondFactor({
  options,
  defaultMethod,
  sendCode,
  verifyCode,
  verifyPasskey,
  offerTrust,
  submitLabel,
  pendingLabel,
  restartLabel,
  onRestart,
}: SecondFactorProps) {
  const offered = useMemo(
    () =>
      options.filter(
        ({ method }) => method !== 'passkey' || verifyPasskey !== undefined
      ),
    [options, verifyPasskey]
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    offered.some(({ id }) => id === defaultMethod) ? defaultMethod : null
  );
  const [trust, setTrust] = useState(false);
  const [sends, setSends] = useState(() => initialSendState(offered));

  const selected = offered.find(({ id }) => id === selectedId);
  const canSwitch = offered.length > 1;

  const trustControl = useMemo<TrustControl | undefined>(
    () =>
      offerTrust ? { checked: trust, onCheckedChange: setTrust } : undefined,
    [offerTrust, trust]
  );

  const handleVerify = useCallback(
    (option: FactorOption, code: string) => verifyCode(option, code, trust),
    [verifyCode, trust]
  );
  const handlePasskey = useCallback(
    async () => verifyPasskey?.(trust),
    [verifyPasskey, trust]
  );
  const handleSent = useCallback(
    (optionId: string, seconds: number) =>
      setSends((previous) => ({
        ...previous,
        [optionId]: { sent: true, availableAt: Date.now() + seconds * 1000 },
      })),
    []
  );
  const showList = useCallback(() => setSelectedId(null), []);

  return (
    <div key={selectedId ?? 'list'} className='animate-fade-in'>
      {selected ? (
        <>
          <p className='mt-1 text-sm text-muted-foreground'>
            {optionHint(selected)}
          </p>
          <MethodPanel
            option={selected}
            sendState={sends[selected.id]}
            onSent={handleSent}
            sendCode={sendCode}
            onVerify={handleVerify}
            onPasskey={handlePasskey}
            trust={trustControl}
            submitLabel={submitLabel}
            pendingLabel={pendingLabel}
          />
          {canSwitch && (
            <Button variant='link' onClick={showList} className='mt-2 w-full'>
              استخدام طريقة أخرى
            </Button>
          )}
        </>
      ) : (
        <MethodList options={offered} onSelect={setSelectedId} />
      )}
      <div className='mt-6 flex flex-wrap items-center justify-center gap-x-2 text-sm text-muted-foreground'>
        {MSG_TWO_FACTOR_RESTART_HINT}
        <Button variant='link' onClick={onRestart} className='h-auto p-0'>
          {restartLabel}
        </Button>
      </div>
    </div>
  );
}

interface MethodPanelProps {
  option: FactorOption;
  sendState: OtpSendState | undefined;
  onSent: (optionId: string, seconds: number) => void;
  sendCode: (option: FactorOption) => Promise<number>;
  onVerify: (option: FactorOption, code: string) => Promise<void>;
  onPasskey: () => Promise<void>;
  trust?: TrustControl;
  submitLabel: string;
  pendingLabel: string;
}

function MethodPanel({
  option,
  sendState,
  onSent,
  sendCode,
  onVerify,
  onPasskey,
  trust,
  submitLabel,
  pendingLabel,
}: MethodPanelProps) {
  if (option.method === 'passkey')
    return <PasskeyPanel onVerify={onPasskey} trust={trust} />;

  if (sendState && option.method === 'otp')
    return (
      <OtpPanel
        option={option}
        state={sendState}
        onSent={onSent}
        sendCode={sendCode}
        onVerify={onVerify}
        trust={trust}
        submitLabel={submitLabel}
        pendingLabel={pendingLabel}
      />
    );

  return (
    <CodePanel
      option={option}
      onVerify={onVerify}
      trust={trust}
      submitLabel={submitLabel}
      pendingLabel={pendingLabel}
    />
  );
}
