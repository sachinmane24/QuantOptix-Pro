import axios from 'axios';

async function testIndex() {
  const req = {
    "IDX_I": ["13"]
  };

  try {
    const res = await axios.post("https://api.dhan.co/v2/marketfeed/quote", req, {
      headers: {
        "access-token": process.env.DHAN_ACCESS_TOKEN || "test",
        "client-id": process.env.DHAN_CLIENT_ID || "1000",
        "Content-Type": "application/json"
      }
    });

    console.log("Response:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Error:", err.response?.data || err.message);
  }
}

testIndex();
