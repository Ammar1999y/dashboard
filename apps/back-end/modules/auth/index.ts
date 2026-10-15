import { sendOtpBinding, verifyOtpBinding } from './otp';
import { sendPasswordlessCodeBinding } from './passwordless';
import { reauthenticateBinding } from './reauth';
import {
  completePasswordResetBinding,
  resetPasswordBinding,
  sendPasswordResetCodeBinding,
  sendRecoverySecondFactorCodeBinding,
} from './recovery';

export const AUTH_BINDINGS = [
  resetPasswordBinding,
  sendRecoverySecondFactorCodeBinding,
  completePasswordResetBinding,
  sendPasswordResetCodeBinding,
  sendOtpBinding,
  verifyOtpBinding,
  sendPasswordlessCodeBinding,
  reauthenticateBinding,
];
