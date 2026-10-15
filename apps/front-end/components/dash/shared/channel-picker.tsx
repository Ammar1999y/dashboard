import type { OtpChannel } from '@app/shared/validation/enums';

import { memo, useCallback } from 'react';

import { useController } from 'react-hook-form';
import { isChannelEnabled } from '@app/shared/validation/otp';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const CHANNEL_LABELS = {
  email: 'البريد الإلكتروني',
  sms: 'رسالة نصية',
  whatsapp: 'واتساب',
} as const satisfies Record<OtpChannel, string>;

interface ChannelPickerProps {
  /** Left out entirely when there is nothing to choose between. */
  channels: readonly OtpChannel[];
  value: OtpChannel | undefined;
  onChange: (channel: OtpChannel) => void;
  disabled?: boolean;
}

/** How a code reaches the same contact, when the deployment offers more than one way. */
export const ChannelPicker = memo(
  ({ channels, value, onChange, disabled }: ChannelPickerProps) => {
    const handleChange = useCallback(
      (next: string) => {
        if (isChannelEnabled(next)) onChange(next);
      },
      [onChange]
    );

    if (channels.length < 2) return null;

    return (
      <Tabs value={value} onValueChange={handleChange}>
        <TabsList className='w-full'>
          {channels.map((channel) => (
            <TabsTrigger key={channel} value={channel} disabled={disabled}>
              {CHANNEL_LABELS[channel]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    );
  }
);

ChannelPicker.displayName = 'ChannelPicker';

/** `ChannelPicker` over a form field holding the channel. */
export const FormChannelPicker = memo(
  ({ name, channels }: { name: string; channels: readonly OtpChannel[] }) => {
    const { field } = useController({ name });
    const value: unknown = field.value;

    return (
      <ChannelPicker
        channels={channels}
        value={
          typeof value === 'string' && isChannelEnabled(value)
            ? value
            : undefined
        }
        onChange={field.onChange}
      />
    );
  }
);

FormChannelPicker.displayName = 'FormChannelPicker';
