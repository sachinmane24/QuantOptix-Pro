import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // FYERS AUTH ENDPOINTS
  app.get("/api/auth/fyers/login", (req, res) => {
    const clientId = process.env.FYERS_CLIENT_ID;
    const redirectUrl = process.env.FYERS_REDIRECT_URL;
    if (!clientId || !redirectUrl) {
      return res.status(500).json({ error: "FYERS_CLIENT_ID or FYERS_REDIRECT_URL not configured" });
    }
    const fyersAuthUrl = `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&response_type=code&state=sample_state`;
    res.redirect(fyersAuthUrl);
  });

  app.get("/api/auth/fyers/callback", async (req, res) => {
    const { auth_code } = req.query;
    const clientId = process.env.FYERS_CLIENT_ID;
    const secretId = process.env.FYERS_SECRET_ID;

    if (!auth_code) return res.status(400).send("No auth code provided");

    try {
      // Exchange code for access token
      const appIdHash = Buffer.from(`${clientId}:${secretId}`).toString('base64');
      const response = await axios.post('https://api-t1.fyers.in/api/v3/validate-authcode', {
        grant_type: 'authorization_code',
        appIdHash: appIdHash,
        code: auth_code
      });

      const accessToken = response.data.access_token;
      
      res.send(`
        <div style="font-family: sans-serif; background: #0a0c10; color: white; padding: 40px; height: 100vh;">
          <h1 style="color: #00ff94;">Authentication Success</h1>
          <p>Your access token has been generated.</p>
          <div style="background: #1a1d23; padding: 20px; border: 1px solid #333; word-break: break-all;">
            <code>${accessToken}</code>
          </div>
          <p>Please copy this token and add it to your <code>.env</code> file as <code>FYERS_ACCESS_TOKEN</code>, then restart the server.</p>
          <a href="/" style="color: #00ff94; text-decoration: none; border: 1px solid #00ff94; padding: 10px 20px; display: inline-block; mt: 20px;">Return to App</a>
        </div>
      `);
    } catch (error: any) {
      res.status(500).send(`Auth Failed: ${error.message}`);
    }
  });

  // Proxy for FYERS Data
  app.get("/api/market/quotes", async (req, res) => {
    const token = process.env.FYERS_ACCESS_TOKEN;
    const { symbols } = req.query;

    if (!token) {
      return res.json({ 
        mock: true, 
        message: "FYERS_ACCESS_TOKEN not set." 
      });
    }
    
    try {
      const response = await axios.get(`https://api-t1.fyers.in/api/v3/quotes?symbols=${symbols}`, {
        headers: { 'Authorization': `${process.env.FYERS_CLIENT_ID}:${token}` }
      });
      res.json(response.data);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch from FYERS", details: error.response?.data || error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
