import axios from 'axios';

async function run() {
  console.log("Triggering auto-login...");
  const loginRes = await axios.post("http://localhost:3000/api/auth/dhan/trigger-env-login");
  const token = loginRes.data.token;
  console.log("Token:", token.substring(0, 5) + "...");
  
  const clientId = "1109852212";

  console.log("Testing array object format...");
  try {
    const res = await axios.post("https://api.dhan.co/v2/marketfeed/ltp", {
      instruments: [
        { exchangeSegment: "NSE_EQ", securityId: "1333" }
      ]
    }, { headers: { "access-token": token, "client-id": clientId, "Content-Type": "application/json" }});
    console.log("Result A:", res.data);
  } catch (err) { console.error("Error A:", err.response?.data); }

  console.log("Testing dictionary format...");
  try {
    const res = await axios.post("https://api.dhan.co/v2/marketfeed/ltp", {
      "NSE_EQ": ["1333"]
    }, { headers: { "access-token": token, "client-id": clientId, "Content-Type": "application/json" }});
    console.log("Result B:", res.data);
  } catch (err) { console.error("Error B:", err.response?.data); }

}
run();
