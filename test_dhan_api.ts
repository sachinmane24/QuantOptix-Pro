import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const token = process.env.DHAN_ACCESS_TOKEN;
  const clientId = process.env.DHAN_CLIENT_ID || "1109852212";

  if (!token) {
    console.error("No token in env");
    return;
  }
  console.log("Token:", token.substring(0, 5) + "...");

  console.log("Testing dictionary format...");
  try {
    const res = await axios.post("https://api.dhan.co/v2/marketfeed/ltp", {
      "NSE_EQ": ["1333"]
    }, { headers: { "access-token": token, "client-id": clientId, "Content-Type": "application/json" }});
    console.log("Result B:", res.data);
  } catch (err) { console.error("Error B:", err.response?.data); }
}
run();
