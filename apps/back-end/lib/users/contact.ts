import type {
  ContactKind,
  OtpChannel,
  PhoneOtpChannel,
} from '@app/shared/validation/enums';

import { eq } from 'drizzle-orm';

import { users } from '@/db/schema';

import { activeUser } from './filters';

/** The `users` column an OTP channel's identifier is stored in. */
function userContactColumn(channel: OtpChannel) {
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
  return activeUser(eq(userContactColumn(channel), identifier));
}

/** The stored destination for a contact kind. */
export function contactOf(
  user: { email: string; phoneNumber: string | null },
  kind: ContactKind
): string | null {
  return kind === 'email' ? user.email : user.phoneNumber;
}
