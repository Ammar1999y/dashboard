import type { OtpChannel, OtpPurpose } from '@app/shared/validation/enums';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import { CustomError } from '@app/shared/error-class';
import {
  otpHtmlFor,
  otpMsg,
  otpSubjectFor,
  otpTextFor,
} from '@app/shared/messages/otp';

import { serverFault } from '@/lib/http/response';
import { sendMailWithDeadline } from '@/lib/smtp';

import { OTP_DELIVERY_OUTBOX } from './config';
import { recordOutboxDelivery } from './outbox';

export const PROVIDER_TIMEOUT_MS = 5000;

// Every error leaving `deliverOtp` carries one of these, never text derived
// from a provider response. Membership, not `instanceof CustomError`, which
// says nothing about where the text came from.
const SAFE_DELIVERY_MESSAGES: ReadonlySet<string> = new Set([
  otpMsg.sendError,
  otpMsg.smsSendError,
  otpMsg.emailSendError,
]);

// Client-set codes from a fixed vocabulary, unlike `message` / `response`,
// which can quote the rejected message and so the code.
const SMTP_ERROR_CODES = new Set([
  'EAUTH',
  'ECONNECTION',
  'EDEADLINE',
  'EDNS',
  'EENVELOPE',
  'EMESSAGE',
  'EPROTOCOL',
  'ESOCKET',
  'ESTREAM',
  'ETIMEDOUT',
]);

function smtpTransportOptions(): SMTPTransport.Options {
  return {
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: PROVIDER_TIMEOUT_MS,
    dnsTimeout: PROVIDER_TIMEOUT_MS,
    greetingTimeout: PROVIDER_TIMEOUT_MS,
    socketTimeout: PROVIDER_TIMEOUT_MS,
  };
}

// ⚠️ Never log `message`: it can quote the provider.
function readErrorField(
  error: unknown,
  key: 'message' | 'name' | 'code'
): string | null {
  if (typeof error !== 'object' || error === null || !(key in error))
    return null;
  const value: unknown = Reflect.get(error, key);
  return typeof value === 'string' ? value : null;
}

/**
 * ⚠️ Nothing provider-controlled goes in: providers echo the submitted text,
 * which holds the plaintext OTP. Provider codes, if ever needed, go in a
 * hard-coded allowlist, never a pattern over provider output.
 */
interface DeliveryDiagnosis {
  msg: string;
  channel: OtpChannel;
  status?: number;
  smtpCode?: string;
  rejected?: number;
  errorName?: string;
}

/** The diagnoses built below; any other `cause` is dropped at the boundary. */
const VETTED_DIAGNOSES = new WeakSet<object>();

/** Logged once, by whichever boundary answers it, with the diagnosis as `cause`. */
function deliveryFailure(
  message: string,
  diagnosis: DeliveryDiagnosis
): CustomError {
  VETTED_DIAGNOSES.add(diagnosis);
  return serverFault(message, diagnosis);
}

function providerFailure(
  message: string,
  channel: OtpChannel,
  response: Response
): CustomError {
  return deliveryFailure(message, {
    msg: 'otp.provider.failed',
    channel,
    status: response.status,
  });
}

async function sendOtpSms(phoneNumber: string, text: string) {
  const response = await fetch('https://apis.deewan.sa/sms/v1/messages', {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: `Bearer ${process.env.DEEWAN_SMS_TOKEN}`,
    },
    body: JSON.stringify({
      senderName: process.env.DEEWAN_SENDER_NAME,
      messageType: 'text',
      messageText: text,
      recipients: phoneNumber,
    }),
  });

  if (!response.ok) throw providerFailure(otpMsg.smsSendError, 'sms', response);
}

async function sendOtpWhatsApp(phoneNumber: string, text: string) {
  const formData = new FormData();
  formData.append('message_type', 'text');
  formData.append('recipients', phoneNumber);
  formData.append('content', text);

  const response = await fetch('https://services.rmz.one/api/whatsapp/send', {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    method: 'POST',
    headers: {
      AUTHORIZATION: `Bearer ${process.env.WHATSAPP_API_KEY}`,
      Accept: 'application/json',
    },
    body: formData,
  });

  if (!response.ok)
    throw providerFailure(otpMsg.sendError, 'whatsapp', response);

  // A non-JSON 2xx body makes `response.json()` throw a SyntaxError that
  // quotes the body.
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw deliveryFailure(otpMsg.sendError, {
      msg: 'otp.provider.unparsable',
      channel: 'whatsapp',
      status: response.status,
    });
  }

  if (
    typeof data !== 'object' ||
    data === null ||
    !('status' in data) ||
    !data.status
  ) {
    // Application-level rejection on a 2xx; nothing from `data` is kept.
    throw providerFailure(otpMsg.sendError, 'whatsapp', response);
  }
}

async function sendOtpEmail(
  email: string,
  code: string,
  purpose: OtpPurpose,
  text: string
) {
  let info: SMTPTransport.SentMessageInfo;

  try {
    info = await sendMailWithDeadline(
      smtpTransportOptions(),
      {
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: otpSubjectFor(purpose),
        text,
        html: otpHtmlFor(code),
      },
      PROVIDER_TIMEOUT_MS
    );
  } catch (error) {
    // The transport error must not escape: an SMTP rejection quotes the
    // message it rejected, which contains the code.
    const rawCode = readErrorField(error, 'code');
    throw deliveryFailure(otpMsg.emailSendError, {
      msg: 'otp.provider.failed',
      channel: 'email',
      smtpCode:
        rawCode !== null && SMTP_ERROR_CODES.has(rawCode) ? rawCode : 'UNKNOWN',
    });
  }

  // A per-recipient refusal resolves instead of throwing; with one recipient it
  // means nothing was sent.
  if (info.rejected && info.rejected.length > 0)
    throw deliveryFailure(otpMsg.emailSendError, {
      msg: 'otp.provider.rejected',
      channel: 'email',
      // A count, never the address: nothing payload-derived leaves here.
      rejected: info.rejected.length,
    });
}

/**
 * ⚠️ The containment boundary: it logs nothing, and whoever answers the error
 * logs it with its `cause`, so no error may leave with provider- or
 * payload-derived text. The text is built inside the `try` so nothing can throw
 * past it.
 */
export async function deliverOtp(
  channel: OtpChannel,
  destination: string,
  code: string,
  purpose: OtpPurpose
) {
  try {
    const text = otpTextFor(purpose, code);
    if (OTP_DELIVERY_OUTBOX) {
      recordOutboxDelivery({
        channel,
        destination,
        purpose,
        code,
        subject: channel === 'email' ? otpSubjectFor(purpose) : null,
        text,
      });
      return;
    }
    if (channel === 'sms') return await sendOtpSms(destination, text);
    if (channel === 'whatsapp') return await sendOtpWhatsApp(destination, text);
    return await sendOtpEmail(destination, code, purpose, text);
  } catch (error) {
    const message = readErrorField(error, 'message');

    if (
      message &&
      error instanceof CustomError &&
      SAFE_DELIVERY_MESSAGES.has(message)
    ) {
      // Fresh, carrying only a diagnosis built here: the serialiser copies
      // every other field of the error.
      const { cause } = error;
      throw serverFault(
        message,
        typeof cause === 'object' &&
          cause !== null &&
          VETTED_DIAGNOSES.has(cause)
          ? cause
          : undefined
      );
    }

    // The class name only; `message` and `response` can quote the provider.
    throw deliveryFailure(otpMsg.sendError, {
      msg: 'otp.delivery.unexpectedError',
      channel,
      errorName: readErrorField(error, 'name') ?? 'Unknown',
    });
  }
}
