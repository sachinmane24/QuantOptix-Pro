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

  const clientId = process.env.FYERS_CLIENT_ID || process.env.FYERS_APP_ID;
  const secretKey = process.env.FYERS_SECRET_KEY || process.env.FYERS_SECRET_ID;
  const userId = process.env.FYERS_USER_ID;
  const pin = process.env.FYERS_PIN;
  const totpSecret = process.env.FYERS_TOTP_SECRET || process.env.FYERS_TOTP_SECRI;
  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  
  // Priority: Secret > Env Defined
  const redirectUri = process.env.FYERS_REDIRECT_URI || process.env.FYERS_REDIRECT_URL || (appUrl ? `${appUrl}/api/auth/fyers/callback` : "https://www.google.com/");

  if (!clientId || !secretKey || !userId || !pin || !totpSecret || !redirectUri) {
    const missing = [];
    if (!clientId) missing.push("FYERS_CLIENT_ID/APP_ID");
    if (!secretKey) missing.push("FYERS_SECRET_KEY/ID");
    if (!userId) missing.push("FYERS_USER_ID");
    if (!pin) missing.push("FYERS_PIN");
    if (!totpSecret) missing.push("FYERS_TOTP_SECRET/SECRI");
    if (!redirectUri) missing.push("FYERS_REDIRECT_URI/URL");
    
    console.log(`[AutoLogin] Missing automated login credentials: ${missing.join(", ")}. Skipping...`);
    return null;
  }

  loginPromise = (async () => {
    try {
      console.log(`[AutoLogin] Starting automated session for USER: ${userId} with CLIENT: ${clientId}`);

      // Helper for base64
      const b64 = (s: string) => Buffer.from(s).toString('base64');

      const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
      };

      // Step 1: send_login_otp (Vagator api-t2)
      console.log("[AutoLogin] Step 1: send_login_otp");
      const r1 = await axios.post("https://api-t2.fyers.in/vagator/v2/send_login_otp", {
        fy_id: userId,
        app_id: "2"
      }, { headers });

      if (r1.data.s !== "ok") {
        throw new Error(`Step 1 Failed: ${JSON.stringify(r1.data)}`);
      }
      let requestKey = r1.data.request_key;

      // Step 2: verify_otp (TOTP)
      console.log("[AutoLogin] Step 2: verify_otp");
      const totpCode = authenticator.generate(totpSecret);
      const r2 = await axios.post("https://api-t2.fyers.in/vagator/v2/verify_otp", {
        request_key: requestKey,
        otp: totpCode
      }, { headers });

      if (r2.data.s !== "ok") {
        throw new Error(`Step 2 Failed: ${JSON.stringify(r2.data)}`);
      }
      requestKey = r2.data.request_key;

      // Step 3: verify_pin_v2 (PIN base64 encoded)
      console.log("[AutoLogin] Step 3: verify_pin_v2");
      const r3 = await axios.post("https://api-t2.fyers.in/vagator/v2/verify_pin_v2", {
        request_key: requestKey,
        identity_type: "pin",
        identifier: b64(pin)
      }, { headers });

      if (r3.data.s !== "ok") {
        throw new Error(`Step 3 Failed: ${JSON.stringify(r3.data)}`);
      }
      const fyersInternalToken = r3.data.data.access_token;

      // Step 4: get auth_code from /api/v3/token
      console.log("[AutoLogin] Step 4: get_auth_code");
      const appIdOnly = clientId.split("-")[0];
      const r4 = await axios.post("https://api-t1.fyers.in/api/v3/token", {
          fyers_id: userId,
          app_id: appIdOnly,
          redirect_uri: redirectUri,
          appType: "100",
          code_challenge: "",
          state: "None",
          scope: "",
          nonce: "",
          response_type: "code",
          create_cookie: true
      }, {
        headers: {
          ...headers,
          "Authorization": `Bearer ${fyersInternalToken}`
        }
      });

      if (r4.data.s !== "ok") {
        throw new Error(`Step 4 Failed: ${JSON.stringify(r4.data)}`);
      }

      const redirectUrl = r4.data.Url;
      const urlObj = new URL(redirectUrl);
      const authCode = urlObj.searchParams.get("auth_code");

      if (!authCode) {
        throw new Error(`Step 4 Failed: Auth code not found in redirect URL: ${redirectUrl}`);
      }

      // Step 5: exchange auth_code for Access Token (Validation)
      console.log("[AutoLogin] Step 5: validate_authcode");
      const appIdHash = crypto.createHash('sha256').update(`${clientId}:${secretKey}`).digest('hex');
      const r5 = await axios.post('https://api-t1.fyers.in/api/v3/validate-authcode', {
        grant_type: 'authorization_code',
        appIdHash: appIdHash,
        code: authCode
      });

      if (r5.data.s !== "ok") {
        throw new Error(`Step 5 Failed: ${JSON.stringify(r5.data)}`);
      }

      const finalAccessToken = r5.data.access_token;
      console.log("[AutoLogin] Success! Access token generated.");
      
      process.env.FYERS_ACCESS_TOKEN = finalAccessToken;
      return finalAccessToken;

    } catch (error: any) {
      const respData = error.response?.data || error.message;
      console.error("[AutoLogin] Failed:", respData);
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

  // Fyers WebSocket Setup
  let fyersDataConn: any = null;

  const setupFyersSocket = () => {
    const token = process.env.FYERS_ACCESS_TOKEN;
    const clientId = process.env.FYERS_CLIENT_ID;

    if (!token || !clientId) {
      console.log("[Fyers WS] Access token or Client ID missing. WS skipped.");
      return;
    }

    try {
      if (fyersDataConn) {
        console.log("[Fyers WS] Closing existing connection for refresh...");
        try { fyersDataConn.close(); } catch (e) {}
      }

      fyersDataConn = new fyers.fyersDataSocket();
      
      fyersDataConn.on("connect", () => {
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
        fyersDataConn.subscribe(symbols);
        fyersDataConn.autoreconnect();
      });

      fyersDataConn.on("message", (message: any) => {
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

      fyersDataConn.on("error", (err: any) => {
        console.error("[Fyers WS] Error:", err);
      });

      fyersDataConn.on("close", () => {
        console.log("[Fyers WS] Connection closed");
      });

      fyersDataConn.connect(clientId, token);
      
      // Start scanner if token exists
      if (scannerService) {
        scannerService.start();
      }
    } catch (error) {
      console.error("[Fyers WS] Setup error:", error);
    }
  };

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
    const allEnvKeys = Object.keys(process.env);
    
    // Check for common Fyers patterns anywhere in the key name (case-insensitive)
    const fyersKeys = allEnvKeys.filter(k => 
      k.toLocaleUpperCase().includes('FYERS') || 
      k.toLocaleUpperCase().includes('CLIENT_ID') ||
      k.toLocaleUpperCase().includes('APP_ID') ||
      k.includes('J07LANWT')
    );
    
    res.json({ 
      status: "alive", 
      time: new Date().toISOString(), 
      tokenPresent: !!process.env.FYERS_ACCESS_TOKEN,
      fyersConfigured: !!(process.env.FYERS_CLIENT_ID || process.env.FYERS_APP_ID) && !!(process.env.FYERS_SECRET_KEY || process.env.FYERS_SECRET_ID),
      autoLoginConfigured: !!process.env.FYERS_USER_ID && !!(process.env.FYERS_TOTP_SECRET || process.env.FYERS_TOTP_SECRI) && !!process.env.FYERS_PIN,
      appUrl: process.env.APP_URL || "NOT_SET",
      fyersKeysFound: fyersKeys,
      allAvailableKeyNames: allEnvKeys.map(k => k.length > 4 ? k.substring(0, 3) + "..." + k.substring(k.length - 2) : k),
      manualRedirectSet: !!(process.env.FYERS_REDIRECT_URI || process.env.FYERS_REDIRECT_URL),
      telegramConfigured: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID,
      telegramKeysFound: allEnvKeys.filter(k => k.includes('TELEGRAM'))
    });
  });

  // AI Analysis Endpoint
  app.post("/api/ai/analyze", async (req, res) => {
    const { stock, optionChain } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
    }

    try {
      const { analyzeTradeProbability } = await import("./src/services/aiAnalysisService");
      const result = await analyzeTradeProbability(stock, optionChain);
      res.json(result);
    } catch (error: any) {
      console.error("[AI API] Error:", error.message);
      res.status(500).json({ error: "Analysis failed", details: error.message });
    }
  });

  app.get("/api/auth/fyers/autologin", async (req, res) => {
    const clientId = process.env.FYERS_CLIENT_ID || process.env.FYERS_APP_ID;
    const userId = process.env.FYERS_USER_ID;
    const totpSecret = process.env.FYERS_TOTP_SECRET || process.env.FYERS_TOTP_SECRI;

    if (!clientId || !userId || !totpSecret) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing credentials for auto-login. Ensure FYERS_CLIENT_ID, FYERS_USER_ID, and FYERS_TOTP_SECRET are set in environment.",
        debug: {
          hasClientId: !!clientId,
          hasUserId: !!userId,
          hasTotp: !!totpSecret,
          keysFound: Object.keys(process.env).filter(k => k.startsWith('FYERS_'))
        }
      });
    }

    const token = await performAutoLogin();
    if (token) {
      try { setupFyersSocket(); } catch (e) {}
      res.json({ success: true, message: "Auto-login successful", token: token.substring(0, 10) + "..." });
    } else {
      res.status(500).json({ success: false, message: "Auto-login failed. Verify PIN and TOTP Secret in environment secrets." });
    }
  });

  app.get("/api/auth/fyers/login", (req, res) => {
    const clientId = process.env.FYERS_CLIENT_ID || process.env.FYERS_APP_ID;
    
    // Auto-detect redirect URL if not explicitly set
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const detectedAppUrl = `${protocol}://${host}`;
    
    const appUrl = process.env.APP_URL?.replace(/\/$/, "") || detectedAppUrl;
    const redirectUrl = process.env.FYERS_REDIRECT_URI || process.env.FYERS_REDIRECT_URL || `${appUrl}/api/auth/fyers/callback`;
    
    const allFyersKeys = Object.keys(process.env).filter(k => k.startsWith('FYERS_'));
    const maskedKeys = allFyersKeys.reduce((acc: any, key) => {
      const val = process.env[key] || '';
      acc[key] = val.length > 5 ? val.substring(0, 3) + "..." + val.substring(val.length - 2) : (val ? "PRESENT" : "EMPTY");
      return acc;
    }, {});

    if (!clientId) {
      return res.status(500).json({ 
        error: "FYERS_CLIENT_ID not configured",
        help: "Please set FYERS_CLIENT_ID (or FYERS_APP_ID) in the environment secrets.",
        debug: {
          keysFound: allFyersKeys,
          maskedValues: maskedKeys,
          detectedHost: host,
          detectedProtocol: protocol,
          appUrl: appUrl
        }
      });
    }

    console.log(`[Auth] Using redirect_uri: ${redirectUrl} for Client: ${clientId}`);
    const fyersAuthUrl = `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&response_type=code&state=sample_state`;
    res.redirect(fyersAuthUrl);
  });

  app.post("/api/auth/fyers/submit-code", async (req, res) => {
    const { auth_code } = req.body;
    const clientId = process.env.FYERS_CLIENT_ID || process.env.FYERS_APP_ID;
    const secretId = process.env.FYERS_SECRET_KEY || process.env.FYERS_SECRET_ID;

    if (!auth_code) return res.status(400).json({ success: false, message: "No auth code provided" });
    if (!clientId || !secretId) return res.status(500).json({ success: false, message: "Server keys not configured" });

    try {
      const appIdHash = crypto.createHash('sha256').update(`${clientId}:${secretId}`).digest('hex');
      const tokenResponse = await axios.post('https://api-t1.fyers.in/api/v3/validate-authcode', {
        grant_type: 'authorization_code',
        appIdHash: appIdHash,
        code: auth_code
      });

      if (tokenResponse.data.s === "ok") {
        const accessToken = tokenResponse.data.access_token;
        process.env.FYERS_ACCESS_TOKEN = accessToken;
        try { setupFyersSocket(); } catch (e) {}
        res.json({ success: true, message: "Login successful via manual code" });
      } else {
        res.status(400).json({ 
          success: false, 
          message: tokenResponse.data.message || "Manual code exchange failed",
          details: tokenResponse.data
        });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, message: "Error during manual code exchange", details: error.message });
    }
  });

  app.get("/api/auth/fyers/callback", async (req, res) => {
    const { auth_code } = req.query;
    const clientId = process.env.FYERS_CLIENT_ID || process.env.FYERS_APP_ID;
    const secretId = process.env.FYERS_SECRET_KEY || process.env.FYERS_SECRET_ID;

    // Use same redirect_uri as during login
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const detectedAppUrl = `${protocol}://${host}`;
    const appUrl = process.env.APP_URL?.replace(/\/$/, "") || detectedAppUrl;
    const redirectUrl = process.env.FYERS_REDIRECT_URI || process.env.FYERS_REDIRECT_URL || `${appUrl}/api/auth/fyers/callback`;

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
      process.env.FYERS_ACCESS_TOKEN = accessToken;
      try { setupFyersSocket(); } catch (e) {}
      
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
    const indexPath = path.join(distPath, "index.html");
    
    app.use(express.static(distPath, { index: false }));

    app.get("*", (req, res) => {
      if (req.path.startsWith("/api")) {
        return res.status(404).json({ error: "API endpoint not found" });
      }
      res.sendFile(indexPath);
    });
  }

  try {
    setupFyersSocket();
  } catch (e) {
    console.error("[Server] Early socket setup failed:", e);
  }

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
    
    // Config Debug
    const cfg = {
      clientId: !!process.env.FYERS_CLIENT_ID,
      secretKey: !!process.env.FYERS_SECRET_KEY,
      userId: !!process.env.FYERS_USER_ID,
      totp: !!process.env.FYERS_TOTP_SECRET,
      pin: !!process.env.FYERS_PIN,
      appUrl: process.env.APP_URL || "MISSING",
      redirectUri: process.env.FYERS_REDIRECT_URI || "DETECTION_MODE"
    };
    console.log(`[Config Status] ClientID: ${cfg.clientId}, AppURL: ${cfg.appUrl}, AutoLogin Ready: ${cfg.userId && cfg.totp && cfg.pin}`);

    // Try auto-login AFTER server is listening
    if (!process.env.FYERS_ACCESS_TOKEN && process.env.FYERS_TOTP_SECRET) {
      console.log("[Server Startup] Triggering automated login...");
      performAutoLogin()
        .then((token) => {
          if (token) {
            console.log("[Server Startup] Automated login successful. Initializing sockets.");
            try {
              setupFyersSocket();
            } catch (e) {
              console.error("[Server Startup] Deferred socket setup failed:", e);
            }
          } else {
            console.log("[Server Startup] Automated login failed or credentials missing.");
          }
        })
        .catch(err => {
          console.error("[Server Startup] login-then-socket chain failed:", err);
        });
    }
  });
}

startServer();
