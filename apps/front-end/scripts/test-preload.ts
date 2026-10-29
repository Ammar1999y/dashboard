// Run before every test file (`bunfig.toml`). Kept outside the git-ignored
// `tests/`: Bun aborts every run, CI's included, when a preload is missing.
// `@app/shared` reads these once, when it first loads, and the form tests load
// it before any mock harness could set them: every two-factor method and both
// code channels on, whatever the local `.env` says, so the routes the mock
// tests are about are served. `lib/env.js` reads the two origins at load, and a
// real build gets them from the environment.
process.env.NEXT_PUBLIC_API_URL ??= 'https://api.test.invalid';
process.env.NEXT_PUBLIC_URL ??= 'http://localhost:3000';
process.env.NEXT_PUBLIC_ENABLED_2FA_METHODS = 'totp,otp,backup_code,passkey';
process.env.NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS = 'email,sms';
process.env.NEXT_PUBLIC_ENABLED_OTP_CHANNELS = 'email,sms';
