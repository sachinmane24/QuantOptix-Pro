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

  // FYERS AUTH ENDPOINTS (Skeleton)
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
    // In a real app, you'd exchange this code for an access token
    // For now, we guide the user to set their access token in the .env
    res.send(`
      <h1>Authentication Success</h1>
      <p>Your auth code is: <code>${auth_code}</code></p>
      <p>Use this to generate an access token and save it to your environment variables as <code>FYERS_ACCESS_TOKEN</code>.</p>
    `);
  });

  // Proxy for FYERS Data
  app.get("/api/market/data", async (req, res) => {
    const token = process.env.FYERS_ACCESS_TOKEN;
    if (!token) {
      return res.json({ 
        mock: true, 
        message: "FYERS_ACCESS_TOKEN not set. Serving simulated data." 
      });
    }
    
    // Example FYERS API call for quotes/data
    try {
      // Mocking successful response for structure
      res.json({ status: "ok", data: "Real-time bridge enabled" });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch from FYERS" });
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
