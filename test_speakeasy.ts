import speakeasy from 'speakeasy';
console.log(speakeasy.totp({ secret: 'JBSWY3DPEHPK3PXP', encoding: 'base32' }));
