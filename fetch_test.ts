import axios from "axios";
axios.get('http://localhost:3000/api/market/quotes?symbols=NSE:RELIANCE-EQ').then((res) => console.log(JSON.stringify(res.data, null, 2))).catch((e) => console.error(e.response ? e.response.data : e.message));
