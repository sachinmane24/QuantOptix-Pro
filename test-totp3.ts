import crypto from "crypto";
function generateTOTP(secretBase32: string): string {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let i = 0; i < secretBase32.length; i++) {
    const val = base32chars.indexOf(secretBase32.charAt(i).toUpperCase());
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  
  let hex = '';
  for (let i = 0; i < bits.length - 7; i += 8) {
    hex += parseInt(bits.substr(i, 8), 2).toString(16).padStart(2, '0');
  }
  
  const key = Buffer.from(hex, 'hex');
  const epoch = Math.floor(Date.now() / 1000);
  const time = Buffer.alloc(8);
  time.writeUInt32BE(Math.floor(epoch / 30), 4);
  
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(time);
  const result = hmac.digest();
  
  const offset = result[result.length - 1] & 0xf;
  const code = (
    ((result[offset] & 0x7f) << 24) |
    ((result[offset + 1] & 0xff) << 16) |
    ((result[offset + 2] & 0xff) << 8) |
    (result[offset + 3] & 0xff)
  ) % 1000000;
  
  return code.toString().padStart(6, '0');
}

console.log(generateTOTP('JBSWY3DPEHPK3PXP'));
