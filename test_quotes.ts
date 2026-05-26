import axios from 'axios';
axios.post("http://localhost:3000/api/market/quotes?symbols=NSE:RELIANCE-EQ").then(res => {
  console.log(JSON.stringify(res.data, null, 2));
}).catch(console.error);
