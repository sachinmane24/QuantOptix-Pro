import axios from 'axios';
const payload = {
  "NSE_EQ": [11536, 1333, 4963] // Reliance, HDFC, ICICI
};

const token = process.env.DHAN_ACCESS_TOKEN || "test";
const cli = process.env.DHAN_CLIENT_ID || "1000";

async function run() {
  try {
    const res = await axios.post("https://api.dhan.co/v2/marketfeed/quote", payload, {
      headers: {
        "access-token": token,
        "client-id": cli,
        "Content-Type": "application/json"
      }
    });
    console.log("Response:", JSON.stringify(res.data, null, 2));
  } catch(e) {
    if(e.response) {
      console.log("Err:", e.response.data);
    } else {
      console.log("Err:", e.message);
    }
  }
}
run();
