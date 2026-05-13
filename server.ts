import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import dotenv from "dotenv";
import { Server } from "socket.io";
import http from "http";
// @ts-ignore
import fyers from "fyers-api-v3";

dotenv.config();

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });
  const PORT = 3000;

  app.use(express.json());

  // FYERS AUTH ENDPOINTS
  app.get("/api/health", (req, res) => {
    res.json({ status: "alive", time: new Date().toISOString(), env: process.env.NODE_ENV });
  });

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

    console.log(`[Proxy] Fetching quotes for symbols size: ${String(symbols).length}`);

    if (!token) {
      return res.json({ 
        mock: true, 
        message: "FYERS_ACCESS_TOKEN not set." 
      });
    }
    
    if (!symbols) {
      return res.status(400).json({ error: "Missing symbols parameter" });
    }
    
    try {
      const fyersModel = new fyers.fyersModel();
      fyersModel.setAppId(process.env.FYERS_CLIENT_ID);
      fyersModel.setAccessToken(token);
      
      // Ensure symbols is a string (join if array)
      const symbolsStr = Array.isArray(symbols) ? symbols.join(",") : String(symbols);
      const response = await fyersModel.get_quotes(symbolsStr);
      
      if (response && response.s === "error") {
        console.error("[Proxy Error] Fyers lib error:", response);
        return res.status(500).json({ 
          error: "Failed to fetch from FYERS lib", 
          details: response,
          symbols_requested: symbols 
        });
      }

      console.log(`[Proxy] Fyers success via lib for ${String(symbols).substring(0, 50)}...`);
      res.json(response);
    } catch (error: any) {
      console.error("[Proxy Error] Fyers call failed:", error.message);
      res.status(500).json({ 
        error: "Failed to fetch from FYERS", 
        details: error.message,
        symbols_requested: symbols 
      });
    }
  });

  // TELEGRAM NOTIFICATIONS
  app.post("/api/notify/telegram", async (req, res) => {
    const { message } = req.body;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      return res.status(500).json({ error: "Telegram configuration missing" });
    }

    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to send Telegram message", details: error.response?.data || error.message });
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

  // FYERS WEBSOCKET INTEGRATION
  const setupFyersSocket = () => {
    const token = process.env.FYERS_ACCESS_TOKEN;
    const clientId = process.env.FYERS_CLIENT_ID;

    if (!token || !clientId) {
      console.log("[Fyers WS] Access token or Client ID missing. WS skipped.");
      return;
    }

    try {
      const fyersData = new fyers.fyersDataSocket();
      
      fyersData.on("connect", () => {
        console.log("[Fyers WS] Connected to Fyers Data Socket");
        // Subscribe to F&O universe and indices
        const symbols = [
          "NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "NSE:INDIAVIX-INDEX",
          "NSE:RELIANCE-EQ", "NSE:HDFCBANK-EQ", "NSE:ICICIBANK-EQ", "NSE:SBIN-EQ", "NSE:INFY-EQ",
          "NSE:TCS-EQ", "NSE:AXISBANK-EQ", "NSE:KOTAKBANK-EQ", "NSE:TATAMOTORS-EQ", "NSE:LT-EQ",
          "NSE:BEL-EQ", "NSE:HAL-EQ", "NSE:TRENT-EQ", "NSE:ADANIENT-EQ", "NSE:ADANIPORTS-EQ",
          "NSE:COFORGE-EQ", "NSE:CHOLAFIN-EQ", "NSE:BAJFINANCE-EQ", "NSE:BHARTIARTL-EQ",
          "NSE:SUNPHARMA-EQ", "NSE:HINDUNILVR-EQ", "NSE:ITC-EQ", "NSE:TITAN-EQ", 
          "NSE:ASIANPAINT-EQ", "NSE:ULTRACEMCO-EQ"
        ];
        fyersData.subscribe(symbols);
        fyersData.autoreconnect();
      });

      fyersData.on("message", (message: any) => {
        // Broadcast to all connected socket.io clients
        io.emit("market-update", message);
      });

      fyersData.on("error", (err: any) => {
        console.error("[Fyers WS] Error:", err);
      });

      fyersData.on("close", () => {
        console.log("[Fyers WS] Connection closed");
      });

      fyersData.connect(clientId, token);
    } catch (error) {
      console.error("[Fyers WS] Setup error:", error);
    }
  };

  setupFyersSocket();

  io.on("connection", (socket) => {
    console.log("[Socket.io] Client connected:", socket.id);
    socket.on("disconnect", () => {
      console.log("[Socket.io] Client disconnected:", socket.id);
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
