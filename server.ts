import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import dotenv from "dotenv";
import { Server } from "socket.io";
import http from "http";
import crypto from "crypto";
// @ts-ignore
import { authenticator } from "otplib";
// @ts-ignore
import fyers from "fyers-api-v3";
import { ScannerService, TradeSignal } from "./src/services/scannerService";
import { PaperTradingService } from "./src/services/paperTradingService";

dotenv.config();

let loginPromise: Promise<string | null> | null = null;
let scannerService: ScannerService | null = null;
let tradingService: PaperTradingService | null = null;

/**
 * Automates the login flow for Fyers V3 using TOTP and PIN.
 * This skips the manual redirect flow.
 */
async function performAutoLogin() {
  if (loginPromise) return loginPromise;

  const clientId = process.env.FYERS_CLIENT_ID;
  const secretKey = process.env.FYERS_SECRET_KEY;
  const userId = process.env.FYERS_USER_ID;
  const pin = process.env.FYERS_PIN;
  const totpSecret = process.env.FYERS_TOTP_SECRET;
  const redirectUri = process.env.FYERS_REDIRECT_URI;

  if (!clientId || !secretKey || !userId || !pin || !totpSecret || !redirectUri) {
    console.log("[AutoLogin] Missing automated login credentials (USER_ID, PIN, TOTP_SECRET, etc.). Skipping...");
    return null;
  }

  loginPromise = (async () => {
    try {
      console.log("[AutoLogin] Starting automated session for USER:", userId);

      // Step 1: Send Login OTP (Internal AppID 2 for Web Login)
      const loginStep1 = await axios.post("https://api-t1.fyers.in/api/v3/send-login-otp-v2", {
        fy_id: userId,
        app_id: "2"
      });

      if (loginStep1.data.s !== "ok") {
        throw new Error(`Step 1 Failed: ${loginStep1.data.message || "Unknown error"}`);
      }
      const requestKey = loginStep1.data.request_key;

      // Step 2: Verify TOTP
      const totpVal = authenticator.generate(totpSecret);
      const loginStep2 = await axios.post("https://api-t1.fyers.in/api/v3/verify-login-otp-v2", {
        fy_id: userId,
        app_id: "2",
        otp: totpVal,
        request_key: requestKey
      });

      if (loginStep2.data.s !== "ok") {
        throw new Error(`Step 2 Failed: ${loginStep2.data.message || "Unknown error"}`);
      }
      const requestKey2 = loginStep2.data.request_key;

      // Step 3: Verify PIN
      const loginStep3 = await axios.post("https://api-t1.fyers.in/api/v3/verify-login-pin-v2", {
        fy_id: userId,
        app_id: "2",
        pin: pin,
        request_key: requestKey2
      });

      if (loginStep3.data.s !== "ok") {
        throw new Error(`Step 3 Failed: ${loginStep3.data.message || "Unknown error"}`);
      }
      const webToken = loginStep3.data.data.access_token;

      // Step 4: Authorize our CUSTOM APP using the session token
      const authCodeResponse = await axios.post("https://api-t1.fyers.in/api/v3/generate-authcode", {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state: "auto_login"
      }, {
        headers: {
          'Authorization': `Bearer ${webToken}`
        }
      });

      if (authCodeResponse.data.s !== "ok") {
        throw new Error(`Step 4 Failed: ${authCodeResponse.data.message || "Unknown error"}`);
      }
      const authCode = authCodeResponse.data.data.authorization_code;

      // Step 5: Exchange auth_code for Access Token
      const appIdHash = crypto.createHash('sha256').update(`${clientId}:${secretKey}`).digest('hex');
      const tokenResponse = await axios.post('https://api-t1.fyers.in/api/v3/validate-authcode', {
        grant_type: 'authorization_code',
        appIdHash: appIdHash,
        code: authCode
      });

      if (tokenResponse.data.s !== "ok") {
        throw new Error(`Step 5 Failed: ${tokenResponse.data.message || "Unknown error"}`);
      }

      const finalAccessToken = tokenResponse.data.access_token;
      console.log("[AutoLogin] Access token generated successfully!");
      
      // Cache it in env for the proxy to use
      process.env.FYERS_ACCESS_TOKEN = finalAccessToken;
      return finalAccessToken;

    } catch (error: any) {
      console.error("[AutoLogin] Failed with error:", error.response?.data || error.message);
      return null;
    } finally {
      loginPromise = null;
    }
  })();

  return loginPromise;
}

async function startServer() {
  console.log("[Server] Starting server initialization...");
  const app = express();
  const httpServer = http.createServer(app);
  
  // Initialize Socket.io
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  console.log("[Server] Core services initializing...");
  scannerService = new ScannerService(io);
  tradingService = new PaperTradingService(io);

  scannerService.onSignal = (signal) => {
    if (tradingService) {
      tradingService.handleSignal(signal);
    }
  };

  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());
  
  // Logging middleware
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      console.log(`[API Request] ${req.method} ${req.path}`);
    }
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "alive", 
      time: new Date().toISOString(), 
      env: process.env.NODE_ENV,
      port: PORT,
      tokenPresent: !!process.env.FYERS_ACCESS_TOKEN
    });
  });

  app.get("/api/auth/fyers/autologin", async (req, res) => {
    const token = await performAutoLogin();
    if (token) {
      res.json({ success: true, message: "Auto-login successful", token: token.substring(0, 10) + "..." });
    } else {
      res.status(500).json({ success: false, message: "Auto-login failed. Check server logs." });
    }
  });

  app.get("/api/auth/fyers/login", (req, res) => {
    const clientId = process.env.FYERS_CLIENT_ID;
    const redirectUrl = process.env.FYERS_REDIRECT_URI;
    if (!clientId || !redirectUrl) {
      return res.status(500).json({ error: "FYERS_CLIENT_ID or FYERS_REDIRECT_URI not configured" });
    }
    const fyersAuthUrl = `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&response_type=code&state=sample_state`;
    res.redirect(fyersAuthUrl);
  });

  app.get("/api/auth/fyers/callback", async (req, res) => {
    const { auth_code } = req.query;
    const clientId = process.env.FYERS_CLIENT_ID;
    const secretId = process.env.FYERS_SECRET_KEY;

    if (!auth_code) return res.status(400).send("No auth code provided");

    try {
      // Exchange code for access token using SHA256 hash
      const appIdHash = crypto.createHash('sha256').update(`${clientId}:${secretId}`).digest('hex');
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
    let token = process.env.FYERS_ACCESS_TOKEN;
    const { symbols } = req.query;

    if (!token && process.env.FYERS_TOTP_SECRET) {
      console.log("[Proxy] Token missing but credentials found. Attempting auto-login...");
      token = await performAutoLogin() || undefined;
    }

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
      const clientId = process.env.FYERS_CLIENT_ID;
      if (!clientId) {
        return res.status(500).json({ error: "FYERS_CLIENT_ID not configured" });
      }

      // Compute correct Authorization header for Fyers V3
      // Format: APP_ID:ACCESS_TOKEN
      // If token already contains ':', use as is, else prepend clientId
      let authHeader = token;
      if (!token.includes(":")) {
        authHeader = `${clientId}:${token}`;
      }
      
      const symbolsStr = Array.isArray(symbols) ? symbols.join(",") : String(symbols);
      console.log(`[Proxy] Requesting quotes via Axios for: ${symbolsStr.substring(0, 50)}...`);
      
      const response = await axios.get(`https://api-t1.fyers.in/data/quotes?symbols=${symbolsStr}`, {
        headers: {
          'Authorization': authHeader
        },
        timeout: 10000
      });
      
      if (response.data && response.data.s === "error") {
        console.error("[Proxy Error] Fyers API error details:", JSON.stringify(response.data));
        return res.status(500).json({ 
          error: "Failed to fetch from FYERS lib", 
          details: response.data.message || response.data,
          symbols_requested: symbols 
        });
      }

      console.log(`[Proxy] Fyers success for ${symbolsStr.split(',').length} symbols`);
      res.json(response.data);
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message;
      console.error("[Proxy Error] Fyers call failed:", errorMsg);
      res.status(500).json({ 
        error: "Failed to fetch from FYERS", 
        details: errorMsg,
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

  // Vite / Static Serving
  if (process.env.NODE_ENV !== "production") {
    console.log("[Server] Running in DEVELOPMENT mode with Vite Middleware");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("[Server] Running in PRODUCTION mode");
    const distPath = path.resolve(process.cwd(), "dist");
    
    // Serve static files first
    app.use(express.static(distPath));
    
    // Catch-all for SPA routing - MUST be after static and API routes
    app.get("*", (req, res) => {
      // Don't intercept API calls
      if (req.path.startsWith("/api")) {
        return res.status(404).json({ error: "API endpoint not found" });
      }
      
      const indexPath = path.join(distPath, "index.html");
      res.sendFile(indexPath, (err) => {
        if (err) {
          console.error(`[Server] Error sending index.html:`, err);
          res.status(500).send("Error loading application. Please check if 'dist' folder exists.");
        }
      });
    });
  }

  // Fyers WebSocket Setup
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

        // Pipe to scanner and trading engine
        if (message.symbol && message.ltp) {
          if (scannerService) {
            scannerService.handleTick(
              message.symbol, 
              message.ltp, 
              message.high_price || message.ltp, 
              message.low_price || message.ltp, 
              message.v || message.vol_traded_today || 0
            );
          }
          if (tradingService) {
            tradingService.updatePnL(message.symbol, message.ltp);
          }
        }
      });

      fyersData.on("error", (err: any) => {
        console.error("[Fyers WS] Error:", err);
      });

      fyersData.on("close", () => {
        console.log("[Fyers WS] Connection closed");
      });

      fyersData.connect(clientId, token);
      
      // Start scanner if token exists
      if (scannerService) {
        scannerService.start();
      }
    } catch (error) {
      console.error("[Fyers WS] Setup error:", error);
    }
  };

  setupFyersSocket();


  io.on("connection", (socket) => {
    console.log("[Socket] Client connected:", socket.id);
    
    // Send initial status
    if (tradingService) {
      const status = tradingService.getStatus();
      socket.emit("auto-trade-status", status.autoTradeEnabled);
      socket.emit("paper-portfolio-update", {
        positions: status.positions,
        balance: status.balance,
        totalPnL: status.positions.reduce((sum, p) => sum + p.pnl, 0)
      });
    }

    socket.on("toggle-auto-trade", (enabled: boolean) => {
      if (tradingService) {
        tradingService.setAutoTrade(enabled);
        io.emit("auto-trade-status", enabled);
      }
    });

    socket.on("disconnect", () => {
      console.log("[Socket] Client disconnected:", socket.id);
    });
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 [Server] Quantitative Trading Engine running on http://0.0.0.0:${PORT}`);
    
    // Try auto-login AFTER server is listening
    if (!process.env.FYERS_ACCESS_TOKEN && process.env.FYERS_TOTP_SECRET) {
      console.log("[Server Startup] Triggering automated login...");
      performAutoLogin().then((token) => {
          if (token) {
            console.log("[Server Startup] Automated login successful. Initializing sockets.");
            setupFyersSocket();
          } else {
            console.log("[Server Startup] Automated login failed or credentials missing.");
          }
      });
    }
  });
}

startServer();
