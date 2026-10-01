// Holds plaintext codes for tests: never log it. `./config.ts` refuses the mode in production.
import type { OtpChannel, OtpPurpose } from '@app/shared/validation/enums';

interface OutboxDelivery {
  channel: OtpChannel;
  destination: string;
  purpose: OtpPurpose;
  code: string;
  /** Email only. */
  subject: string | null;
  text: string;
  at: Date;
}

const deliveries: OutboxDelivery[] = [];

export function recordOutboxDelivery(
  delivery: Omit<OutboxDelivery, 'at'>
): void {
  deliveries.push({ ...delivery, at: new Date() });
}

export function readOutbox(
  filter: Partial<
    Pick<OutboxDelivery, 'channel' | 'destination' | 'purpose'>
  > = {}
): OutboxDelivery[] {
  return deliveries.filter(
    (delivery) =>
      (filter.channel === undefined || delivery.channel === filter.channel) &&
      (filter.destination === undefined ||
        delivery.destination === filter.destination) &&
      (filter.purpose === undefined || delivery.purpose === filter.purpose)
  );
}

export function clearOutbox(): void {
  deliveries.length = 0;
}
