import axios from 'axios';
axios.post('http://localhost:3000/api/auth/dhan/trigger-env-login').then(res => console.log(res.data)).catch(err => console.error(err.response?.data));
