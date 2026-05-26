const axios = require('axios');
axios.get('http://localhost:3000/api/market/quotes?symbols=NSE:RELIANCE-EQ').then((res:any) => console.log(JSON.stringify(res.data, null, 2))).catch((e:any) => console.error(e.response.data || e.message));
