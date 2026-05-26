import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.DHAN_ACCESS_TOKEN;
const clientId = process.env.DHAN_CLIENT_ID || "1000000000";

async function testIndex() {
  const req = {
    "IDX_I": ["13", "25", "37"],
    "NSE_EQ": ["2885"] // Reliance just to test
  };

  try {
    const res = await axios.post("https://api.dhan.co/v2/marketfeed/ltp", req, {
      headers: {
        "access-token": token,
        "client-id": clientId,
        "Content-Type": "application/json"
      }
    });

    console.log("Response:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Error:", err.response?.data || err.message);
  }
}

testIndex();
