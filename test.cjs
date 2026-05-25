const fs = require('fs');
fetch("https://dhanhq.co/docs/v2/authentication/")
  .then(res => res.text())
  .then(text => {
    fs.writeFileSync("dhan.html", text);
  });
