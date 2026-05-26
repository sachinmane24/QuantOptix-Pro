import axios from 'axios';

async function run() {
  try {
    const res = await axios.post("http://localhost:3000/api/breakout/trigger-scan", {});
    console.log("Success:", res.data);
  } catch (e) {
    if (e.response) {
      console.log("Error status:", e.response.status);
      console.log("Error data:", e.response.data);
    } else {
      console.log("Error:", e.message);
    }
  }
}

run();
