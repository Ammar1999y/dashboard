import type { Page } from '@/types/page';

import { OTP_ENABLED } from '@app/shared/validation/otp';

import ForgotPassword from '@/components/dash/auth/forgot-password';

const ForgotPasswordPage: Page = () => <ForgotPassword />;
ForgotPasswordPage.title = 'نسيت كلمة المرور';
ForgotPasswordPage.standalone = true;

export default ForgotPasswordPage;

// The server answers 404 for every recovery route when no OTP channel is on.
export function getStaticProps() {
  return OTP_ENABLED ? { props: {} } : { notFound: true as const };
}
