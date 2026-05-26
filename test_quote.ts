import axios from 'axios';
import fs from 'fs';
import path from 'path';

async function testIndex() {
  let token = process.env.DHAN_ACCESS_TOKEN || "";
  let cli = process.env.DHAN_CLIENT_ID || "";
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(process.cwd(), "dhan-credentials.json"), "utf8"));
    if (creds.accessToken) token = creds.accessToken;
    if (creds.clientId) cli = creds.clientId;
  } catch (e) {}

  const req = {
    "NSE_EQ": [2885]
  };

  try {
    const res = await axios.post("https://api.dhan.co/v2/marketfeed/quote", req, {
      headers: {
        "access-token": token,
        "client-id": cli,
        "Content-Type": "application/json"
      }
    });

    console.log("LTP Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("LTP Error:", err.response?.data || err.message);
  }
}

testIndex();
