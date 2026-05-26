import { TOTP } from 'otplib';
const t = new TOTP({ secret: 'JBSWY3DPEHPK3PXP' });
t.generate().then(console.log);
