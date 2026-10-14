import * as OTPAuth from 'otpauth';
const secret = new OTPAuth.Secret({ size: 20 });
const totp = new OTPAuth.TOTP({ issuer: 'ledgerline', label: 'operator', algorithm: 'SHA1', digits: 6, period: 30, secret });
// Setup output intentionally contains the new secret; save it directly in your password manager.
console.log(totp.toString());
