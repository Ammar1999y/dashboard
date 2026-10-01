import type { OtpChannel, OtpPurpose } from '@app/shared/validation/enums';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { OTP_EXPIRY_MINUTES } from '@app/shared/validation/constants';

import { sendMailWithDeadline } from '@/lib/smtp';

import { logSanitized } from '@/utils/log';

import { OTP_DELIVERY_OUTBOX } from './config';
import { otpSubjectFor, otpTextFor } from './content';
import { recordOutboxDelivery } from './outbox';

export const PROVIDER_TIMEOUT_MS = 5000;

// Every error leaving `deliverOtp` carries one of these, never text derived
// from a provider response.
export const MSG_OTP_SEND_FAILED = 'حدثت مشكلة اثناء إرسال رمز التحقق';
const MSG_SMS_SEND_FAILED = 'حدثت مشكلة اثناء إرسال رمز التحقق عبر SMS';
const MSG_WHATSAPP_SEND_FAILED = MSG_OTP_SEND_FAILED;
const MSG_EMAIL_SEND_FAILED =
  'حدثت مشكلة اثناء إرسال رمز التحقق عبر البريد الإلكتروني';

// Membership, not `instanceof CustomError`, which says nothing about where the text came from.
const SAFE_DELIVERY_MESSAGES: ReadonlySet<string> = new Set([
  MSG_OTP_SEND_FAILED,
  MSG_SMS_SEND_FAILED,
  MSG_EMAIL_SEND_FAILED,
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
 * ⚠️ Nothing provider-controlled is logged: providers echo the submitted text,
 * which holds the plaintext OTP. Provider codes, if ever needed, go in a
 * hard-coded allowlist, never a pattern over provider output.
 */
function logProviderFailure(channel: OtpChannel, response: Response) {
  logSanitized('error', {
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

  if (!response.ok) {
    logProviderFailure('sms', response);
    throw new CustomError(MSG_SMS_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }
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

  if (!response.ok) {
    logProviderFailure('whatsapp', response);
    throw new CustomError(MSG_WHATSAPP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }

  // A non-JSON 2xx body makes `response.json()` throw a SyntaxError that
  // quotes the body.
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    logSanitized('error', {
      msg: 'otp.provider.unparsable',
      channel: 'whatsapp',
      status: response.status,
    });
    throw new CustomError(MSG_WHATSAPP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }

  if (
    typeof data !== 'object' ||
    data === null ||
    !('status' in data) ||
    !data.status
  ) {
    // Application-level rejection on a 2xx; nothing from `data` is logged.
    logProviderFailure('whatsapp', response);
    throw new CustomError(MSG_WHATSAPP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
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
        html: `<div dir="rtl" style="font-family: sans-serif; text-align: center; padding: 20px;">
      <h2>رمز التحقق</h2>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0;">${code}</p>
      <p>صالح لمدة ${OTP_EXPIRY_MINUTES} دقائق</p>
    </div>`,
      },
      PROVIDER_TIMEOUT_MS
    );
  } catch (error) {
    // The transport error must not escape: an SMTP rejection quotes the
    // message it rejected, which contains the code.
    const rawCode = readErrorField(error, 'code');
    logSanitized('error', {
      msg: 'otp.provider.failed',
      channel: 'email',
      smtpCode:
        rawCode !== null && SMTP_ERROR_CODES.has(rawCode) ? rawCode : 'UNKNOWN',
    });
    throw new CustomError(MSG_EMAIL_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }

  // A per-recipient refusal resolves instead of throwing; with one recipient it
  // means nothing was sent.
  if (info.rejected && info.rejected.length > 0) {
    logSanitized('error', {
      msg: 'otp.provider.rejected',
      channel: 'email',
      // A count, never the address: nothing payload-derived leaves here.
      rejected: info.rejected.length,
    });
    throw new CustomError(MSG_EMAIL_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }
}

/**
 * ⚠️ The containment boundary: callers log what they catch, so no error may
 * leave with provider- or payload-derived text. The text is built inside the
 * `try` so nothing can throw past it.
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
      // Fresh: only the message was checked, and the serialiser copies other fields.
      throw new CustomError(message, HTTP_STATUS.INTERNAL_ERROR);
    }

    // The class name only; `message` and `response` can quote the provider.
    logSanitized('error', {
      msg: 'otp.delivery.unexpectedError',
      channel,
      errorName: readErrorField(error, 'name') ?? 'Unknown',
    });
    throw new CustomError(MSG_OTP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }
}
