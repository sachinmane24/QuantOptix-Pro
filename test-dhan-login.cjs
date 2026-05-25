const axios = require('axios');
const otplib = require('otplib');
require('dotenv').config();

async function testAuth() {
  const totp = otplib.authenticator.generate(process.env.DHAN_TOTP_KEY || '64CKS35A37722C546O2D5AIG3I======');
  
  const url = `https://api.dhan.co/v2/generateAccessToken?dhanClientId=${process.env.DHAN_CLIENT_ID}&pin=${process.env.DHAN_PIN}&totp=${totp}`;
  // wait, the url was https://auth.dhan.co/app/generateAccessToken in python script
  
  try {
    const res = await axios.post(`https://auth.dhan.co/app/generateAccessToken?dhanClientId=${process.env.DHAN_CLIENT_ID || '1105955688'}&pin=${process.env.DHAN_PIN || 'xxxx'}&totp=${totp}`);
    console.log("Status:", res.status);
    console.log("Data:", res.data);
  } catch (err) {
    if (err.response) {
      console.log("Error status:", err.response.status);
      console.log("Error data:", err.response.data);
    } else {
      console.log(err.message);
    }
  }
}
testAuth();
