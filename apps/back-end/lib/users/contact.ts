import type { OtpChannel, PhoneOtpChannel } from '@app/shared/validation/enums';

import { and, eq, isNull } from 'drizzle-orm';

import { users } from '@/db/schema';

/** The `users` column an OTP channel's identifier is stored in. */
export function userContactColumn(channel: OtpChannel) {
  return channel === 'email' ? users.email : users.phoneNumber;
}

/** The identifier a channel-discriminated OTP body names. */
export function contactIdentifier(
  input:
    | { channel: 'email'; email: string }
    | { channel: PhoneOtpChannel; phoneNumber: string }
): string {
  return input.channel === 'email' ? input.email : input.phoneNumber;
}

/** The live account holding this contact, for the anonymous OTP routes. */
export function activeUserWithContact(channel: OtpChannel, identifier: string) {
  return and(
    eq(userContactColumn(channel), identifier),
    isNull(users.deletedAt),
    eq(users.isActive, true)
  );
}
