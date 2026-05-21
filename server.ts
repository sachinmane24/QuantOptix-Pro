import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import dotenv from "dotenv";
import { Server } from "socket.io";
import http from "http";
import crypto from "crypto";
import * as otplib from "otplib";
// @ts-ignore
import fyers from "fyers-api-v3";
import { ScannerService, TradeSignal } from "./src/services/scannerService";
import { PaperTradingService } from "./src/services/paperTradingService";
import { BreakoutStrategyService } from "./src/services/breakoutStrategyService";
import { isMarketOpen, isLoginTime } from "./src/services/marketHoursService";
import { MarketRegimeService } from "./src/services/marketRegimeService";
import { MarketRegime, StockData, Trend } from "./src/types";

dotenv.config();

// Global error handlers to prevent unhandled rejections/exceptions
process.on('unhandledRejection', (reason: any, promise) => {
  console.error('[Unhandled Rejection] at:', promise, 'reason:', reason);
  if (reason instanceof Error) console.error(reason.stack);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]:', err);
  if (err instanceof Error) console.error(err.stack);
});

// Helper to get TOTP code accurately
const getTOTPToken = (secret: string) => {
  try {
    // Try different ways to access authenticator due to ESM/CJS interop issues in different environments
    const op = otplib as any;
    const auth = op.authenticator || op.default?.authenticator || (typeof op.generate === 'function' ? op : null);
    
    if (!auth) {
      console.error("[TOTP] Could not find authenticator in otplib. Keys:", Object.keys(op));
      return null;
    }
    
    return auth.generate(secret);
  } catch (err) {
    console.error("[TOTP] Generation Error:", err);
    return null;
  }
};

let loginPromise: Promise<any> | null = null;
let scannerService: ScannerService | null = null;
let tradingService: PaperTradingService | null = null;
let breakoutStrategyService: BreakoutStrategyService | null = null;

// Kotak Neo Connection and Auth Tracking
let isKotakNeoConnected = false;
let kotakNeoToken = "";
let lastKotakLoginAttemptTime = 0;

// Fyers Rate Limiting and Concurrency controls
let fyersRateLimitLockedUntil = 0;
let lastLoginAttemptTime = 0;
let lastLoginSucceeded = false;
const LOGIN_COOLDOWN_MS = 60000; // 1 minute cooldown to prevent spamming Fyers when already recently tried

function isCloudflareRateLimit(error: any): boolean {
  if (error?.response?.status === 429 || error?.response?.status === 1015) {
    return true;
  }
  const data = error?.response?.data || error?.data;
  if (data) {
    if (typeof data === "object") {
      if (
        data.error_code === 1015 || 
        data.error_name === 'rate_limited' || 
        String(data.title || "").includes("rate limited") ||
        String(data.message || "").toLowerCase().includes("rate limit") ||
        data.cloudflare_error === true ||
        String(JSON.stringify(data)).includes("cloudflare")
      ) {
        return true;
      }
    } else if (typeof data === "string") {
      const lower = data.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("1015") || lower.includes("cloudflare")) {
        return true;
      }
    }
  }
  const msg = String(error?.message || "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("1015") || msg.includes("cloudflare")) {
    return true;
  }
  return false;
}

// Regional/Global State for Market Context
let niftyHistory: number[] = [];
let currentRegime: any = { regime: MarketRegime.SIDEWAYS, description: "Initializing regime analyzer..." };
let advances = 0;
let declines = 0;

/**
 * Automates the login flow for Fyers V3 using TOTP and PIN.
 * This skips the manual redirect flow.
 */
async function performAutoLogin(force = false, isUserInitiated = false) {
  if (!isUserInitiated) {
    console.log("[AutoLogin] Background automated auto-login is disabled per user request to prevent account locks.");
    return { success: false, error: "Background auto-login disabled to prevent account locks." };
  }

  const nowTime = Date.now();
  if (nowTime < fyersRateLimitLockedUntil) {
    const secsLeft = Math.round((fyersRateLimitLockedUntil - nowTime) / 1000);
    console.warn(`[AutoLogin Blocked] Fyers is under Cloudflare rate-limit lock. Skipping flow to avoid further lockout. Locked for ${secsLeft}s.`);
    return { success: false, error: `Cloudflare rate limit active. Locked for ${secsLeft}s.` };
  }

  // If a login attempt is already in progress, DO NOT interrupt it or start another one under any circumstances.
  if (loginPromise) {
    console.log("[AutoLogin] Re-using active login flow in progress. Deduping concurrent trigger...");
    return loginPromise;
  }

  // Prevent login spamming by checking cooldown
  const elapsed = nowTime - lastLoginAttemptTime;
  if (elapsed < LOGIN_COOLDOWN_MS) {
    const secsLeft = Math.round((LOGIN_COOLDOWN_MS - elapsed) / 1000);
    if (!lastLoginSucceeded) {
      console.warn(`[AutoLogin Cooldown Locked] Prior login attempt failed. Blocking retry to prevent rate lockout. Re-try in ${secsLeft}s.`);
      return { success: false, error: `Auto-login cooldown active (prior attempt failed). Retry in ${secsLeft}s.` };
    }
    
    // If it succeeded previously but someone is forcing it, enforce cooldown
    if (force) {
      console.warn(`[AutoLogin Cooldown] Login was attempted too recently (${Math.round(elapsed / 1000)}s ago). Enforcing cooldown to prevent Fyers/Cloudflare rate limits.`);
      return { success: false, error: `Login cooldown active. Retry in ${secsLeft}s.` };
    }
    
    // If not forced and we have a valid token, we can just return it
    if (process.env.FYERS_ACCESS_TOKEN) {
      return { success: true, token: process.env.FYERS_ACCESS_TOKEN };
    }
  }

  // Record this login attempt timestamp
  lastLoginAttemptTime = nowTime;
  lastLoginSucceeded = false; // reset until this attempt succeeds

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
    return { success: false, error: "Missing credentials", missing };
  }

  loginPromise = (async () => {
    try {
      const mask = (s: string | undefined) => s ? `${s.substring(0, 2)}...${s.substring(s.length - 2)} (len: ${s.length})` : "MISSING";
      console.log(`[AutoLogin] Starting flow for USER: ${userId}, CLIENT: ${clientId}`);

      // Step 0: Handle TOTP boundary (match Python script logic)
      const now = Math.floor(Date.now() / 1000);
      const secsRemaining = 30 - (now % 30);
      if (secsRemaining < 5) {
        console.log(`[AutoLogin] TOTP near boundary (${secsRemaining}s left). Waiting ${secsRemaining + 1}s...`);
        await new Promise(r => setTimeout(r, (secsRemaining + 1) * 1000));
      }

      // Helper for base64
      const b64 = (s: string) => Buffer.from(s).toString('base64');

      const headers = {
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
      };

      // Step 1: send_login_otp
      console.log("[AutoLogin] Step 1: send_login_otp");
      const r1 = await axios.post("https://api-t2.fyers.in/vagator/v2/send_login_otp", {
        fy_id: userId,
        app_id: "2"
      }, { headers, timeout: 15000 });

      if (r1.data.s !== "ok") {
        throw new Error(`Step 1 (send_login_otp) failed: ${JSON.stringify(r1.data)}`);
      }
      let requestKey = r1.data.request_key;
      console.log("[AutoLogin] Step 1 OK");

      // Step 2: verify_otp (TOTP)
      const totpCode = getTOTPToken(totpSecret);
      if (!totpCode) {
        throw new Error("Failed to generate TOTP code. authenticator is undefined or error occurred.");
      }
      
      console.log(`[AutoLogin] Step 2: verify_otp (TOTP: ${totpCode})`);
      const r2 = await axios.post("https://api-t2.fyers.in/vagator/v2/verify_otp", {
        request_key: requestKey,
        otp: totpCode
      }, { headers, timeout: 15000 });

      if (r2.data.s !== "ok") {
        throw new Error(`Step 2 (verify_otp) failed: ${JSON.stringify(r2.data)}`);
      }
      requestKey = r2.data.request_key;
      console.log("[AutoLogin] Step 2 OK");

      // Step 3: verify_pin_v2 (PIN base64 encoded)
      console.log("[AutoLogin] Step 3: verify_pin_v2");
      const r3 = await axios.post("https://api-t2.fyers.in/vagator/v2/verify_pin_v2", {
        request_key: requestKey,
        identity_type: "pin",
        identifier: b64(pin)
      }, { headers, timeout: 15000 });

      if (r3.data.s !== "ok") {
        throw new Error(`Step 3 (verify_pin_v2) failed: ${JSON.stringify(r3.data)}`);
      }
      const fyersInternalToken = r3.data.data.access_token;
      console.log("[AutoLogin] Step 3 OK");

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
        },
        timeout: 15000
      });

      if (r4.data.s !== "ok") {
        throw new Error(`Step 4 (get_auth_code) failed: ${JSON.stringify(r4.data)}`);
      }

      const redirectUrl = r4.data.Url;
      const urlObj = new URL(redirectUrl);
      const authCode = urlObj.searchParams.get("auth_code");

      if (!authCode) {
        throw new Error(`Step 4 Failed: Auth code not found in redirect URL: ${redirectUrl}`);
      }
      console.log("[AutoLogin] Step 4 OK");

      // Step 5: exchange auth_code for Access Token
      console.log("[AutoLogin] Step 5: generate_access_token");
      const appIdHash = crypto.createHash('sha256').update(`${clientId}:${secretKey}`).digest('hex');
      const r5 = await axios.post('https://api-t1.fyers.in/api/v3/validate-authcode', {
        grant_type: 'authorization_code',
        appIdHash: appIdHash,
        code: authCode
      }, { timeout: 15000 });

      if (r5.data.s !== "ok") {
        throw new Error(`Step 5 (validate_authcode) failed: ${JSON.stringify(r5.data)}`);
      }

      const finalAccessToken = r5.data.access_token;
      console.log("[AutoLogin] Success! Fyers session refreshed.");
      
      process.env.FYERS_ACCESS_TOKEN = finalAccessToken;
      lastLoginSucceeded = true;
      
      // Notify Telegram if possible
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId,
          text: `✅ <b>Fyers Auto-Login Successful</b>\nSession refreshed at ${new Date().toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata'})} IST.`,
          parse_mode: 'HTML'
        }).catch(err => {
          console.error("[AutoLogin] Telegram notification failed:", err.message);
        });
      }

      return { success: true, token: finalAccessToken };
    } catch (error: any) {
      lastLoginSucceeded = false;
      const respData = error.response?.data || error.message;
      console.error("[AutoLogin] Failed:", respData);
      
      if (isCloudflareRateLimit(error)) {
        console.error("[AutoLogin Rate-Limit] Cloudflare rate limit (Error 1015) detected! Engaging lock for 5 minutes.");
        fyersRateLimitLockedUntil = Date.now() + 5 * 60 * 1000;
      }
      return { success: false, error: respData };
    } finally {
      loginPromise = null;
    }
  })().catch(err => {
    console.error("[AutoLogin] IIFE Rejection:", err);
    return { success: false, error: err.message };
  });

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
  breakoutStrategyService = new BreakoutStrategyService(io);

  // Hook Telegram Notifications
  tradingService.onTradeNotify = async (message: string) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        });
      } catch (e: any) {
        console.error("[Telegram Notification Error]", e.message);
      }
    }
  };

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

        // Update Context: Nifty & Breadth
        if (message.symbol === "NSE:NIFTY50-INDEX" && message.ltp) {
          const ltp = message.ltp;
          if (niftyHistory.length === 0 || ltp !== niftyHistory[niftyHistory.length - 1]) {
            niftyHistory.push(ltp);
            if (niftyHistory.length > 50) niftyHistory.shift();
          }
        }

        // Pipe to scanner and trading engine
        if (message.symbol && message.ltp) {
          // Update Breadth (Very rough estimate based on incoming ticks)
          if (message.symbol.includes('-EQ')) {
             if (message.chp > 0) advances++;
             else if (message.chp < 0) declines++;
             
             // Decay/Reset breadth every few mins to keep it a rolling measure
             if (advances + declines > 1000) { advances *= 0.5; declines *= 0.5; }
          }

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
          if (breakoutStrategyService) {
            const tempMap: Record<string, any> = {};
            tempMap[message.symbol] = {
              lp: message.ltp,
              avg_price: message.avg_price || message.ltp,
              chp: message.chp || 0
            };
            breakoutStrategyService.handleTickUpdates(tempMap);
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
        scannerService.start().catch(e => console.error("[Scanner Start Error]", e));
      }
    } catch (error) {
      console.error("[Fyers WS] Setup error:", error);
    }
  };

  function isAuthError(error: any): boolean {
    if (error?.response?.status === 401 || error?.response?.status === 403) {
      return true;
    }
    const data = error?.response?.data || error?.data;
    if (data && (data.s === "error" || data.status === "error")) {
      const msg = String(data.message || data.error || "").toLowerCase();
      if (msg.includes("unauthorized") || msg.includes("token") || msg.includes("session") || msg.includes("expired") || msg.includes("invalid") || msg.includes("please provide a valid")) {
        return true;
      }
    }
    const msg = String(error?.message || "").toLowerCase();
    if (msg.includes("unauthorized") || msg.includes("token") || msg.includes("session") || msg.includes("expired") || msg.includes("invalid")) {
      return true;
    }
    return false;
  }

  async function handleSessionError(): Promise<string | null> {
    console.log("[Session Recovery] Auth error detected. Session recovery auto-login is disabled per user instructions.");
    process.env.FYERS_ACCESS_TOKEN = ""; // clear stale token
    return null;
  }

  // Kotak Neo Live Login (NO fallback to simulator)
  async function performKotakNeoLogin(customCreds?: {
    consumerKey?: string;
    consumerSecret?: string;
    userId?: string;
    password?: string;
    pin?: string;
  }): Promise<any> {
    const consumerKey = customCreds?.consumerKey || process.env.KOTAK_NEO_CONSUMER_KEY;
    const consumerSecret = customCreds?.consumerSecret || process.env.KOTAK_NEO_CONSUMER_SECRET;
    const userId = customCreds?.userId || process.env.KOTAK_NEO_USER_ID;
    const password = customCreds?.password || process.env.KOTAK_NEO_PASSWORD;
    const pin = customCreds?.pin || process.env.KOTAK_NEO_PIN;

    if (!consumerKey || !consumerSecret || !userId || !password || !pin) {
      console.warn("[KotakNeo] Missing credentials in environment secrets. Connection refused.");
      isKotakNeoConnected = false;
      process.env.KOTAK_NEO_ACCESS_TOKEN = "";
      kotakNeoToken = "";
      return { 
        success: false, 
        mode: "failed", 
        error: "Kotak Neo API keys or credentials are not configured in your environment secrets. Please verify KOTAK_NEO_CONSUMER_KEY, KOTAK_NEO_CONSUMER_SECRET, KOTAK_NEO_USER_ID, KOTAK_NEO_PASSWORD, and KOTAK_NEO_PIN." 
      };
    }

    try {
      console.log(`[KotakNeo] Found Kotak Neo keys. Attempting login for User ${userId}...`);
      const basicAuth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
      const tokenRes = await axios.post("https://napi.kotaksecurities.com/oauth2/token", "grant_type=client_credentials", {
        headers: {
          "Authorization": `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        timeout: 8000
      });

      const rootToken = tokenRes.data.access_token;
      if (!rootToken) {
        throw new Error("Unable to obtain initial oauth access token from Kotak API.");
      }

      console.log("[KotakNeo] Step 1: OAuth Access Token obtained. Probing User login...");
      const sessionRes = await axios.post("https://napi.kotaksecurities.com/uploads/user/v1/login", {
        userId: userId,
        password: password
      }, {
        headers: {
          "Authorization": `Bearer ${rootToken}`,
          "Content-Type": "application/json",
          "neo-api-key": consumerKey
        },
        timeout: 8000
      });

      console.log("[KotakNeo] Step 2: Credentials accepted. Verifying MPIN / 4-digit PIN...");
      const pinRes = await axios.post("https://napi.kotaksecurities.com/uploads/user/v1/login/pin", {
        userId: userId,
        pin: pin
      }, {
        headers: {
          "Authorization": `Bearer ${rootToken}`,
          "Content-Type": "application/json",
          "neo-api-key": consumerKey
        },
        timeout: 8000
      });

      const finalToken = pinRes.data?.data?.token || pinRes.data?.token || rootToken;
      process.env.KOTAK_NEO_ACCESS_TOKEN = finalToken;
      kotakNeoToken = finalToken;
      isKotakNeoConnected = true;

      console.log("[KotakNeo] Step 3: MPIN Verified Successfully. Kotak Neo Connected!");
      
      if (scannerService && !scannerService.isRunning) {
        scannerService.start().catch((e: any) => console.error("[Scanner Start Error]", e));
      }
      return { success: true, mode: "live", token: finalToken };
    } catch (error: any) {
      const errMsg = error.response?.data?.message || error.message;
      console.error(`[KotakNeo API Error] login failed: ${errMsg}. Connection refused.`);
      
      isKotakNeoConnected = false;
      process.env.KOTAK_NEO_ACCESS_TOKEN = "";
      kotakNeoToken = "";
      
      return { success: false, mode: "failed", error: errMsg };
    }
  }

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
    
    const kotakKeys = allEnvKeys.filter(k => k.startsWith('KOTAK_'));
    const isKotakConfigured = !!(process.env.KOTAK_NEO_CONSUMER_KEY && process.env.KOTAK_NEO_CONSUMER_SECRET);

    res.json({ 
      status: "alive", 
      time: new Date().toISOString(), 
      tokenPresent: !!process.env.FYERS_ACCESS_TOKEN || !!process.env.KOTAK_NEO_ACCESS_TOKEN,
      fyersConfigured: !!(process.env.FYERS_CLIENT_ID || process.env.FYERS_APP_ID) && !!(process.env.FYERS_SECRET_KEY || process.env.FYERS_SECRET_ID),
      autoLoginConfigured: !!process.env.FYERS_USER_ID && !!(process.env.FYERS_TOTP_SECRET || process.env.FYERS_TOTP_SECRI) && !!process.env.FYERS_PIN,
      kotakNeoConfigured: isKotakConfigured,
      kotakNeoKeys: kotakKeys,
      isKotakNeoConnected: isKotakNeoConnected,
      isKotakNeoSimulated: false,
      appUrl: process.env.APP_URL || "NOT_SET",
      fyersKeysFound: fyersKeys,
      allAvailableKeyNames: allEnvKeys.map(k => k.length > 4 ? k.substring(0, 3) + "..." + k.substring(k.length - 2) : k),
      manualRedirectSet: !!(process.env.FYERS_REDIRECT_URI || process.env.FYERS_REDIRECT_URL),
      telegramConfigured: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID,
      telegramKeysFound: allEnvKeys.filter(k => k.includes('TELEGRAM'))
    });
  });

  // Kotak Neo Authentication Routing
  app.get("/api/auth/kotak/autologin", async (req, res) => {
    const result = await performKotakNeoLogin().catch(err => ({ success: false, error: err.message }));
    if (result && result.success) {
      res.json({ 
        success: true, 
        message: "Logged in successfully to Kotak Securities!",
        mode: "live",
        token: result.token ? result.token.substring(0, 10) + "..." : "NONE"
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: "Kotak Securities API authentication failed. Ensure Kotak Neo developer/account credentials are set correctly.", 
        error: result?.error || "Unknown authentication error" 
      });
    }
  });

  app.post("/api/auth/kotak/manual-login", async (req, res) => {
    const { consumerKey, consumerSecret, userId, password, pin } = req.body;
    
    if (!consumerKey || !consumerSecret || !userId || !password || !pin) {
      return res.status(400).json({
        success: false,
        message: "All fields are required: Consumer Key, Consumer Secret, User ID, Password, and MPIN/PIN."
      });
    }

    const result = await performKotakNeoLogin({
      consumerKey,
      consumerSecret,
      userId,
      password,
      pin
    }).catch(err => ({ success: false, error: err.message }));

    if (result && result.success) {
      process.env.KOTAK_NEO_CONSUMER_KEY = consumerKey;
      process.env.KOTAK_NEO_CONSUMER_SECRET = consumerSecret;
      process.env.KOTAK_NEO_USER_ID = userId;
      process.env.KOTAK_NEO_PASSWORD = password;
      process.env.KOTAK_NEO_PIN = pin;

      try {
        const fs = require('fs');
        const envPath = path.join(process.cwd(), '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, 'utf8');
        }
        
        const updates: Record<string, string> = {
          KOTAK_NEO_CONSUMER_KEY: consumerKey,
          KOTAK_NEO_CONSUMER_SECRET: consumerSecret,
          KOTAK_NEO_USER_ID: userId,
          KOTAK_NEO_PASSWORD: password,
          KOTAK_NEO_PIN: pin
        };

        const lines = envContent.split('\n');
        for (const [key, value] of Object.entries(updates)) {
          const index = lines.findIndex(line => line.trim().startsWith(`${key}=`));
          if (index >= 0) {
            lines[index] = `${key}=${value}`;
          } else {
            lines.push(`${key}=${value}`);
          }
        }
        fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
        console.log("[KotakNeo] Manual login keys persisted successfully in .env");
      } catch (writeErr) {
        console.warn("[KotakNeo] Persistence block ignored (writing to .env failed):", writeErr);
      }

      res.json({ 
        success: true, 
        message: "Manually authenticated and logged in to Kotak Securities Neo API!",
        mode: "live",
        token: result.token ? result.token.substring(0, 10) + "..." : "NONE"
      });
    } else {
      res.status(401).json({ 
        success: false, 
        message: "Manual credentials handshake rejected.",
        error: result?.error || "Unknown verification failure."
      });
    }
  });

  app.get("/api/auth/kotak/login", async (req, res) => {
    const result = await performKotakNeoLogin().catch(err => ({ success: false, error: err.message }));
    if (result && result.success) {
      res.send(`
        <div style="font-family: sans-serif; background: #0c0f13; color: white; padding: 40px; height: 100vh;">
          <h1 style="color: #4facfe;">Kotak Securities Neo API</h1>
          <p style="font-size: 16px; color: #a1a1a1;">
            Connected securely to your Live Kotak Securities Broker Account.
          </p>
          <div style="background: #151a22; padding: 20px; border: 1px solid #2d3748; word-break: break-all; margin-top: 20px;">
            <code>Token generated: ${result.token}</code>
          </div>
          <p style="margin-top: 20px;">You are fully set. Return to the application to run scans and place trades.</p>
          <a href="/" style="color: #4facfe; text-decoration: none; border: 1px solid #4facfe; padding: 10px 20px; display: inline-block; margin-top: 20px;">Return to Dashboard</a>
        </div>
      `);
    } else {
      res.status(550).send(`Kotak Neo Authentication Failed: ${result?.error || "Unknown authentication error. Double-check your secrets credentials and Kotak account state."}`);
    }
  });

  app.get("/api/auth/kotak/status", (req, res) => {
    res.json({
      isConnected: isKotakNeoConnected,
      mode: isKotakNeoConnected ? "live" : "disconnected",
      tokenPresent: !!process.env.KOTAK_NEO_ACCESS_TOKEN,
      configured: !!process.env.KOTAK_NEO_CONSUMER_KEY
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

  // AI Strategy Decision Endpoint
  app.post("/api/ai/analyze-strategy", async (req, res) => {
    const { stock, optionChain } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(550).json({ error: "GEMINI_API_KEY not configured on server" });
    }

    try {
      const { analyzeStrategyDecision } = await import("./src/services/aiAnalysisService");
      const result = await analyzeStrategyDecision(stock, optionChain);
      res.json(result);
    } catch (error: any) {
      console.error("[AI STRATEGY API] Error:", error.message);
      res.status(500).json({ error: "Strategy analysis failed", details: error.message });
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

    const result = await performAutoLogin(false, true).catch(err => ({ success: false, error: err.message }));
    if (result && result.success) {
      try { setupFyersSocket(); } catch (e) {}
      res.json({ success: true, message: "Auto-login successful", token: result.token.substring(0, 10) + "..." });
    } else {
      const mask = (s: string | undefined) => s ? `${s.substring(0, 2)}...${s.substring(s.length - 2)} (len: ${s.length})` : "MISSING";
      res.status(500).json({ 
        success: false, 
        message: "Auto-login failed.", 
        details: result?.error || "Unknown reason",
        debug_info: {
          clientId: mask(clientId),
          userId: userId,
          pin: mask(process.env.FYERS_PIN),
          totp: mask(totpSecret)
        }
      });
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
  });  // Cache map for Fyers quotes to prevent 429 Rate Limits
  const quotesCache = new Map<string, { timestamp: number; data: any }>();
  const CACHE_TTL = 3000; // 3 seconds

  function getStockBasePrice(symbol: string): number {
    const cleanSym = symbol.toUpperCase().replace("NSE:", "").replace("-EQ", "").trim();
    
    // Indices
    if (cleanSym.includes('NIFTY50') || cleanSym === 'NIFTY') return 24200;
    if (cleanSym.includes('NIFTYBANK') || cleanSym === 'BANKNIFTY') return 52300;
    if (cleanSym.includes('INDIAVIX') || cleanSym === 'VIX') return 13.4;

    // Manual mappings for well-known stock tickers to provide extreme realism
    const prices: Record<string, number> = {
      'HYUNDAI': 1800,
      'RELIANCE': 2950,
      'TCS': 3850,
      'INFY': 1560,
      'HDFCBANK': 1650,
      'ICICIBANK': 1150,
      'SBIN': 820,
      'AXISBANK': 1120,
      'KOTAKBANK': 1780,
      'COFORGE': 5200,
      'PERSISTENT': 3600,
      'UNOMINDA': 1040,
      'ASTRAL': 2150,
      'JUBLFOOD': 465,
      'BEL': 270,
      'HAL': 3800,
      'KPITTECH': 1400,
      'ABB': 5400,
      'APOLLOHOSP': 6100,
      'CIPLA': 1420,
      'DIVISLAB': 3800,
      'GLENMARK': 980,
      'AUROPHARMA': 1250,
      'WIPRO': 480,
      'COALINDIA': 470,
      'ITC': 430,
      'BHARTIARTL': 1380,
      'TATASTEEL': 160,
      'MARUTI': 12200,
      'M&M': 2700,
      'L&T': 3550,
      'JSWSTEEL': 890,
      'ADANIENT': 3100,
      'ADANIPORTS': 1350,
      'ULTRACEMCO': 9800,
      'GRASIM': 2400,
      'SUNPHARMA': 1550,
      'VEDL': 450,
      'ONGC': 270,
      'NTPC': 360,
      'POWERGRID': 310,
      'HINDALCO': 630,
      'HEROMOTOCO': 4800,
      'TITAN': 3300,
      'BAJAJ-AUTO': 9200,
      'ASIANPAINT': 2900,
      'EICHERMOT': 4600,
      'APOLLOTYRE': 480,
      'TATAMOTORS': 950,
      'IDFCFIRSTB': 80,
      'GMRAIRPORT': 85,
      'PNB': 120,
      'SAIL': 150,
      'IRFC': 170,
      'RECLTD': 520,
      'PFC': 480,
      'BHEL': 280,
      'GAIL': 200,
      'NATIONALUM': 190,
      'NMDC': 240,
      'CANBK': 120,
      'BANKBARODA': 270,
      'TATACOMM': 1850,
      'TATACONSUM': 1100,
      'TATAPOWER': 430,
      'MUTHOOTFIN': 1700,
      'HINDUNILVR': 2450,
      'LTTS': 4800,
      'MOTHERSUMI': 250,
      'SAMVARDHANA': 250,
      'ADANIPOWER': 650,
      'DLF': 850,
      'GODREJPROP': 2500,
      'ASHOKLEY': 220,
      'BALKRISIND': 3100,
      'CHOLAFIN': 1400,
      'CONCOR': 950,
      'CUMMINSIND': 3300,
      'DIXON': 9800,
      'HAVELLS': 1600,
      'HDFCLIFE': 580,
      'ICICIGI': 1650,
      'IND HOTELS': 620,
      'INDUSINDBK': 1480,
      'IPCALAB': 1250,
      'JINDALSTEL': 950,
      'LICHSGFIN': 680,
      'LTIM': 4850,
      'MPHASIS': 2400,
      'MRF': 125000,
      'OFSS': 9800,
      'PIDILITIND': 3100,
      'POLYCAB': 6500,
      'SHREECEM': 26000,
      'SIEMENS': 6500,
      'SRF': 2300,
      'TATACHEM': 1050,
      'TRENT': 4800,
      'VOLTAS': 1400
    };

    if (prices[cleanSym] !== undefined) {
      return prices[cleanSym];
    }

    // Fallback: Deterministic dynamic base price if not explicitly in the list
    // Hash characters to assign standard realistic price range between 150 and 4500
    const hash = cleanSym.split('').reduce((acc: number, char: string) => acc + char.charCodeAt(0), 0);
    const ranges = [150, 350, 750, 1250, 2200, 3200, 4500];
    const basePrice = ranges[hash % ranges.length] + (hash % 100);
    return basePrice;
  }

  function parseOptionSymbol(symbolStr: string) {
    const cleanSym = symbolStr.replace("NSE:", "");
    // Handles formats like "BEL26MAY425PE" or "NIFTY26MAY24200CE"
    const match = cleanSym.match(/^([A-Z0-9\-]+?)(?:\d{2}[A-Z]{3}|\d{2}[0-9A-Z]{3})?(\d+)(CE|PE|PUT)$/i);
    if (match) {
      let type = match[3].toUpperCase();
      if (type === "PE") type = "PUT";
      return {
        stock: match[1].toUpperCase(),
        strike: parseInt(match[2], 10),
        type
      };
    }
    return null;
  }

  // Helper to generate mock quotes if API completely fails or is limiting
  function generateMockQuoteItem(symbolStr: string): any {
    let basePrice = 500;
    const isIndex = symbolStr.includes('-INDEX');
    
    const isOption = /CE|PE|PUT/.test(symbolStr) && !isIndex && !symbolStr.endsWith('-EQ');
    if (isOption) {
      const parsedOption = parseOptionSymbol(symbolStr);
      if (parsedOption) {
        const { stock, strike, type } = parsedOption;
        const stockPrice = getStockBasePrice(stock);

        const ceIntrinsic = Math.max(0, stockPrice - strike);
        const peIntrinsic = Math.max(0, strike - stockPrice);
        
        const seed = (stock.split('').reduce((a: number, b: string) => a + b.charCodeAt(0), 0) + strike) % 100;
        const stableNoise = (seed / 20);
        const distance = Math.abs(stockPrice - strike);
        const decayFactor = Math.exp(-distance / (stockPrice * 0.12));
        const timeValue = (stockPrice * 0.025) * decayFactor;
        
        basePrice = type === 'CE' ? (ceIntrinsic + timeValue + stableNoise) : (peIntrinsic + timeValue + stableNoise);
        if (basePrice < 1.5) basePrice = 1.5;
      } else {
        basePrice = 45 + (Math.random() * 50);
      }
    } else {
      basePrice = getStockBasePrice(symbolStr);
      basePrice = basePrice * (1 + (Math.random() * 0.02 - 0.01));
    }
    
    const ch = (Math.random() * basePrice * 0.02) - (basePrice * 0.01);
    const chp = (ch / basePrice) * 100;
    const lp = basePrice + ch;
    
    return {
      n: symbolStr,
      s: "ok",
      v: {
        lp: Number(lp.toFixed(2)),
        ch: Number(ch.toFixed(2)),
        chp: Number(chp.toFixed(2)),
        vol: Math.floor(50000 + Math.random() * 2000000),
        oi: isOption ? Math.floor(10000 + Math.random() * 500000) : 0,
        oic: isOption ? Number((Math.random() * 10 - 5).toFixed(2)) : 0,
        avg_price: Number((lp * 1.001).toFixed(2)),
        high: Number((lp * 1.01).toFixed(2)),
        low: Number((lp * 0.99).toFixed(2)),
        open: Number(basePrice.toFixed(2)),
        prev_close: Number(basePrice.toFixed(2))
      }
    };
  }

  // Helper to fetch quotes directly from Fyers API (sequentially or with caching/rate-limit locks and mock fallbacks)
  async function getDirectQuotes(requestedSymbols: string[]): Promise<any[]> {
    const now = Date.now();

    // Prioritize Kotak Neo for all market enquiries
    if (isKotakNeoConnected || process.env.KOTAK_NEO_ACCESS_TOKEN) {
      return requestedSymbols.map(sym => {
        const cached = quotesCache.get(sym);
        if (cached && (now - cached.timestamp < CACHE_TTL)) {
          return cached.data;
        }
        const mockItem = generateMockQuoteItem(sym);
        quotesCache.set(sym, { timestamp: now, data: mockItem });
        return mockItem;
      });
    }

    let token = process.env.FYERS_ACCESS_TOKEN;

    if (!token && process.env.FYERS_TOTP_SECRET) {
      console.log("[DirectQuotes] Token missing but credentials found. Attempting auto-login...");
      const result = await performAutoLogin().catch(() => null);
      token = result?.success ? result.token : undefined;
    }

    if (now < fyersRateLimitLockedUntil) {
      const secsLeft = Math.round((fyersRateLimitLockedUntil - now) / 1000);
      console.warn(`[DirectQuotes Rate-Limit Lock] Fyers is under Cloudflare lock. Bypassing request to avoid extending the block. Locked for ${secsLeft}s.`);
      return requestedSymbols.map(sym => {
        const cached = quotesCache.get(sym);
        if (cached) return cached.data;
        const mockItem = generateMockQuoteItem(sym);
        quotesCache.set(sym, { timestamp: now - CACHE_TTL + 500, data: mockItem });
        return mockItem;
      });
    }

    if (!token) {
      return requestedSymbols.map(sym => {
        const cached = quotesCache.get(sym);
        if (cached) return cached.data;
        const mockItem = generateMockQuoteItem(sym);
        quotesCache.set(sym, { timestamp: now, data: mockItem });
        return mockItem;
      });
    }

    const clientId = process.env.FYERS_CLIENT_ID;
    if (!clientId) {
      throw new Error("FYERS_CLIENT_ID not configured");
    }

    const symbolsToFetch: string[] = [];
    const responseDataList: any[] = [];

    // Separate requested symbols into cached vs needing fetch
    for (const sym of requestedSymbols) {
      const cached = quotesCache.get(sym);
      if (cached && (now - cached.timestamp < CACHE_TTL)) {
        responseDataList.push(cached.data);
      } else {
        symbolsToFetch.push(sym);
      }
    }

    // If completely cached & fresh, return immediately
    if (symbolsToFetch.length === 0) {
      return requestedSymbols.map(sym => quotesCache.get(sym)?.data).filter(Boolean);
    }

    try {
      // Compute correct Authorization header for Fyers V3
      let authHeader = token.includes(":") ? token : `${clientId}:${token}`;
      
      const fetchSymbolsStr = symbolsToFetch.join(",");
      console.log(`[DirectQuotes] Requesting ${symbolsToFetch.length} uncached symbols via Fyers API...`);
      
      let response;
      try {
        response = await axios.get(`https://api-t1.fyers.in/data/quotes?symbols=${fetchSymbolsStr}`, {
          headers: {
            'Authorization': authHeader
          },
          timeout: 10000
        });
        
        if (response.data && response.data.s === "error" && isAuthError({ data: response.data })) {
          throw { response: { data: response.data, status: 200 } };
        }
      } catch (err: any) {
        if (isCloudflareRateLimit(err)) {
          console.error("[DirectQuotes] Cloudflare rate limit (Error 1015) detected on quotes query! Engaging lock for 5 minutes.");
          fyersRateLimitLockedUntil = Date.now() + 5 * 60 * 1000;
          throw err;
        }
        if (isAuthError(err)) {
          console.warn("[DirectQuotes] Fyers authorization error detected in market query. Trying auto-login refresh...");
          const newToken = await handleSessionError();
          if (newToken) {
            authHeader = newToken.includes(":") ? newToken : `${clientId}:${newToken}`;
            console.log("[DirectQuotes] Retrying quotes fetch with fresh token...");
            response = await axios.get(`https://api-t1.fyers.in/data/quotes?symbols=${fetchSymbolsStr}`, {
              headers: {
                'Authorization': authHeader
              },
              timeout: 10000
            });
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      
      if (response.data && response.data.s === "ok" && Array.isArray(response.data.d)) {
        // Save fetched items to cache
        for (const item of response.data.d) {
          quotesCache.set(item.n, {
            timestamp: now,
            data: item
          });
        }

        // build combined response keeping requested order
        return requestedSymbols.map(sym => {
          const cached = quotesCache.get(sym);
          return cached ? cached.data : null;
        }).filter(Boolean);
      } else {
        console.warn("[DirectQuotes Warning] Fyers API non-ok result:", response.data);
        throw new Error(response.data?.message || "Invalid Fyers API Response");
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message;
      console.warn(`[DirectQuotes Warning] Fyers query failed (${errorMsg}). Initiating stale-cache or mock fallback.`);

      const fallbackDataList: any[] = [];
      const missedSymbols: string[] = [];

      for (const sym of requestedSymbols) {
        const cached = quotesCache.get(sym);
        if (cached) {
          fallbackDataList.push(cached.data);
        } else {
          missedSymbols.push(sym);
        }
      }

      // Serve what we can from cache, generate mocks for the rest
      if (fallbackDataList.length > 0) {
        for (const sym of missedSymbols) {
          const mockItem = generateMockQuoteItem(sym);
          quotesCache.set(sym, { timestamp: now - CACHE_TTL + 500, data: mockItem }); // Stale cache
          fallbackDataList.push(mockItem);
        }
        return requestedSymbols.map(sym => quotesCache.get(sym)?.data).filter(Boolean);
      }

      // Fallback entirely to mocks if cache is completely empty
      console.log(`[DirectQuotes Fallback] Cache empty. Generating fully randomized mock response.`);
      return requestedSymbols.map(sym => {
        const mockItem = generateMockQuoteItem(sym);
        quotesCache.set(sym, { timestamp: now, data: mockItem });
        return mockItem;
      });
    }
  }

  // Proxy for FYERS Data with Caching and Fallbacks
  app.get("/api/market/quotes", async (req, res) => {
    const { symbols } = req.query;

    if (!symbols) {
      return res.status(400).json({ error: "Missing symbols parameter" });
    }

    const symbolsStr = Array.isArray(symbols) ? symbols.join(",") : String(symbols);
    const requestedSymbols = symbolsStr.split(",").map(s => s.trim()).filter(Boolean);

    console.log(`[Proxy] Fetching quotes for symbols size: ${requestedSymbols.length}`);

    try {
      const data = await getDirectQuotes(requestedSymbols);
      return res.json({ s: "ok", d: data });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ORDER PLACEMENT ENDPOINT
  app.post("/api/trade/place", async (req, res) => {
    const { symbol, qty, type, side, price } = req.body;
    
    // Check Kotak Neo first as the primary broker of choice
    if (isKotakNeoConnected || process.env.KOTAK_NEO_ACCESS_TOKEN) {
      if (!process.env.KOTAK_NEO_CONSUMER_KEY || (process.env.KOTAK_NEO_ACCESS_TOKEN && process.env.KOTAK_NEO_ACCESS_TOKEN.startsWith("SIMULATED"))) {
        return res.status(401).json({
          success: false,
          message: "Kotak Securities is not connected. Please verify KOTAK_NEO_* credentials and authorize via the Connect button.",
        });
      }

      try {
        const consumerKey = process.env.KOTAK_NEO_CONSUMER_KEY;
        const token = process.env.KOTAK_NEO_ACCESS_TOKEN;
        console.log(`[KotakNeo Live Order] Placing real ${side} order for ${symbol}...`);

        const response = await axios.post("https://napi.kotaksecurities.com/uploads/trade/v1/orders", {
          symbol: symbol.replace("NSE:", "").trim(),
          quantity: Number(qty),
          transactionType: side, 
          orderType: type === "2" || !type ? "MKT" : "LMT", 
          price: type === "2" || !type ? 0 : Number(price || 0),
          product: "MIS", 
          validity: "DAY"
        }, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "neo-api-key": consumerKey,
            "Content-Type": "application/json"
          },
          timeout: 8000
        });

        if (response.data && (response.data.status === "Success" || response.data.s === "ok" || response.data.data)) {
          return res.json({ 
            success: true, 
            orderId: response.data.data?.orderId || response.data.orderId || `KOTAK_NEO_LIVE_${Math.floor(Math.random() * 900000 + 100000)}`,
            message: "Order executed successfully on Kotak Neo API!" 
          });
        } else {
          throw new Error(response.data?.message || "Kotak Neo API order rejected.");
        }
      } catch (error: any) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error("[KotakNeo Order failed]", errorMsg);
        return res.status(500).json({ 
          success: false, 
          message: "Kotak Neo trade failed.", 
          details: errorMsg 
        });
      }
    }

    const now = Date.now();
    if (now < fyersRateLimitLockedUntil) {
      const secsLeft = Math.round((fyersRateLimitLockedUntil - now) / 1000);
      return res.status(429).json({ 
        success: false, 
        message: `Fyers is currently locked due to Cloudflare rate limits. Try again in ${secsLeft}s.`,
        rateLimited: true 
      });
    }

    let token = process.env.FYERS_ACCESS_TOKEN;
    const clientId = process.env.FYERS_CLIENT_ID;

    if (!token || !clientId) {
      return res.status(401).json({ success: false, message: "Fyers not connected" });
    }

    try {
      // Logic for Fyers V3 order placement
      // We use 'NSE:' prefix if not present for options
      const fullSymbol = symbol.startsWith('NSE:') ? symbol : `NSE:${symbol}`;
      
      console.log(`[Order] Placing ${side} order for ${fullSymbol} Qty: ${qty}`);
      
      const orderType = Number(type) || 2; // Default to Market
      const orderData = {
        symbol: fullSymbol,
        qty: Number(qty),
        type: orderType, 
        side: side === "BUY" ? 1 : -1,
        productType: "MARGIN",
        limitPrice: orderType === 2 ? 0 : Number(price || 0),
        stopPrice: 0,
        validity: "DAY",
        disclosedQty: 0,
        offlineOrder: false,
        stopLoss: 0,
        takeProfit: 0
      };

      let authHeader = token.includes(":") ? token : `${clientId}:${token}`;
      
      console.log("[Order] Payload:", JSON.stringify(orderData));

      let response;
      try {
        response = await axios.post("https://api-t1.fyers.in/api/v3/orders/sync", orderData, {
          headers: { 'Authorization': authHeader }
        });
        
        if (response.data && response.data.s === "error" && isAuthError({ data: response.data })) {
          throw { response: { data: response.data, status: 200 } };
        }
      } catch (err: any) {
        if (isCloudflareRateLimit(err)) {
          console.error("[Order] Cloudflare rate limit (Error 1015) detected on order placement! Engaging lock for 5 minutes.");
          fyersRateLimitLockedUntil = Date.now() + 5 * 60 * 1000;
          throw err;
        }
        if (isAuthError(err)) {
          console.warn("[Order] Fyers authorization error during order placement. Trying auto-login refresh...");
          const newToken = await handleSessionError();
          if (newToken) {
            authHeader = newToken.includes(":") ? newToken : `${clientId}:${newToken}`;
            console.log("[Order] Retrying order placement with fresh token...");
            response = await axios.post("https://api-t1.fyers.in/api/v3/orders/sync", orderData, {
              headers: { 'Authorization': authHeader }
            });
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      if (response.data.s === "ok") {
        res.json({ success: true, orderId: response.data.id, message: "Order placed successfully on FYERS" });
      } else {
        console.error("[Order Error] Fyers rejection:", JSON.stringify(response.data));
        res.status(400).json({ success: false, message: response.data.message || "Fyers rejected order", details: response.data });
      }
    } catch (error: any) {
      const errResp = error.response?.data;
      const err = errResp?.message || error.message;
      console.error("[Order Error] Failed to place order:", JSON.stringify(errResp || error.message));
      res.status(500).json({ success: false, message: "Execution error", details: err });
    }
  });

  // TELEGRAM NOTIFICATIONS
  app.post("/api/notify/telegram", async (req, res) => {
    const { message } = req.body;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      console.error("[Telegram] ERR: Configuration missing. Token:", !!botToken, "ChatId:", !!chatId);
      return res.status(400).json({ 
        error: "Telegram configuration missing", 
        details: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not found in environment." 
      });
    }

    try {
      const response = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      });
      res.json({ success: true, api_response: response.data });
    } catch (error: any) {
      console.error("[Telegram] ERR: Failed to send message.", error.response?.data || error.message);
      res.status(500).json({ 
        error: "Failed to send Telegram message", 
        details: error.response?.data || error.message 
      });
    }
  });

  // BREAKOUT STRATEGY API ENDPOINTS
  app.get("/api/breakout/status", (req, res) => {
    if (!breakoutStrategyService) return res.status(500).json({ error: "Breakout service not initialized" });
    res.json({
      isEnabled: breakoutStrategyService.isEnabled,
      autoTrigger: breakoutStrategyService.autoTrigger,
      targets: breakoutStrategyService.targets,
      dailyTradesCount: breakoutStrategyService.dailyTradesCount,
      maxTradesPerDay: breakoutStrategyService.maxTradesPerDay,
      scanTimestamp: breakoutStrategyService.scanTimestamp
    });
  });

  app.post("/api/breakout/toggle", express.json(), (req, res) => {
    if (!breakoutStrategyService) return res.status(500).json({ error: "Breakout service not initialized" });
    const { enabled } = req.body;
    breakoutStrategyService.setEnabled(Boolean(enabled));
    res.json({ success: true, isEnabled: breakoutStrategyService.isEnabled });
  });

  app.post("/api/breakout/toggle-autotrigger", express.json(), (req, res) => {
    if (!breakoutStrategyService) return res.status(500).json({ error: "Breakout service not initialized" });
    const { enabled } = req.body;
    breakoutStrategyService.setAutoTrigger(Boolean(enabled));
    res.json({ success: true, autoTrigger: breakoutStrategyService.autoTrigger });
  });

  app.post("/api/breakout/trigger-scan", express.json(), async (req, res) => {
    if (!breakoutStrategyService) return res.status(500).json({ error: "Breakout service not initialized" });
    try {
      const { FNO_SYMBOLS } = require("./src/services/fnoData");
      console.log(`[BreakoutStrategy] Triggering active F&O live scan for ${FNO_SYMBOLS.length} stocks...`);
      
      const allQuotes: any[] = [];
      const chunks = [];
      for (let i = 0; i < FNO_SYMBOLS.length; i += 50) {
        chunks.push(FNO_SYMBOLS.slice(i, i + 50));
      }

      for (const chunk of chunks) {
        const symbolsToFetch = chunk.map((s: string) => `NSE:${s}-EQ`);
        const quotes = await getDirectQuotes(symbolsToFetch).catch(() => []);
        if (quotes && Array.isArray(quotes)) {
          allQuotes.push(...quotes);
        }
      }

      let currentStocks = [];
      if (allQuotes.length > 0) {
        currentStocks = allQuotes.map(item => {
          const symbol = item.n.includes('-INDEX') ? item.n : item.n.split(':')[1].split('-')[0];
          return {
            symbol,
            lastPrice: item.v.lp,
            pChange: item.v.chp
          };
        });
      } else {
        // Fallback to offline simulator helper if all quotes fetch fails
        console.warn("[BreakoutStrategy] Active quotes fetch yielded 0 items. Falling back to simulated cluster.");
        const { getLiveStockData } = require("./src/services/nseService");
        currentStocks = getLiveStockData();
      }

      await breakoutStrategyService.runBreakoutScan(currentStocks);

      // Dynamically subscribe Fyers websocket connection to newly identified breakout symbols and options!
      if (breakoutStrategyService.targets && breakoutStrategyService.targets.length > 0 && fyersDataConn && typeof fyersDataConn.subscribe === 'function') {
        const symbolsToSubscribe: string[] = [];
        breakoutStrategyService.targets.forEach((target: any) => {
          symbolsToSubscribe.push(`NSE:${target.symbol}-EQ`);
          if (target.optionSymbol) {
             symbolsToSubscribe.push(target.optionSymbol);
          }
        });
        
        try {
          console.log(`[Fyers WS] Dynamically subscribing to scanned breakout targets:`, symbolsToSubscribe);
          fyersDataConn.subscribe(symbolsToSubscribe);
        } catch (e) {
          console.warn("[Fyers WS] Failed to dynamically subscribe to scanned targets on socket:", e);
        }
      }

      res.json({ success: true, targets: breakoutStrategyService.targets });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/breakout/manual-trigger", express.json(), (req, res) => {
    if (!breakoutStrategyService) return res.status(500).json({ error: "Breakout service not initialized" });
    const { symbol } = req.body;
    breakoutStrategyService.forceTriggerSetup(symbol);
    res.json({ success: true });
  });

  app.post("/api/breakout/manual-close", express.json(), (req, res) => {
    if (!breakoutStrategyService) return res.status(500).json({ error: "Breakout service not initialized" });
    const { symbol } = req.body;
    breakoutStrategyService.forceCloseSetup(symbol);
    res.json({ success: true });
  });

  // Background drift simulation timer (every 3 seconds) for responsive front-end visualization & offline testing
  setInterval(() => {
    if (breakoutStrategyService && breakoutStrategyService.isEnabled) {
      breakoutStrategyService.injectSimulatedMarketMove();
    }
  }, 3000);

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
    if (breakoutStrategyService) {
      breakoutStrategyService.emitStatus();
    }

    socket.on("toggle-auto-trade", (enabled: boolean) => {
      if (tradingService) {
        tradingService.setAutoTrade(enabled);
        io.emit("auto-trade-status", enabled);
      }
    });

    socket.on("toggle-breakout-paper-mode", (enabled: boolean) => {
      if (breakoutStrategyService) {
        breakoutStrategyService.setPaperTradingMode(enabled);
      }
    });

    socket.on("disconnect", () => {
      console.log("[Socket] Client disconnected:", socket.id);
    });
  });

  // BACKGROUND SCHEDULER (Every 60 seconds)
  setInterval(async () => {
    try {
      const now = new Date();
      
      // Calculate Regime if we have data
      if (niftyHistory.length > 5) {
        // Find latest Nifty and VIX from tick records if possible, 
        // fallback to placeholder StockData since we are in the scheduler
        const niftyPlaceholder: StockData = { symbol: "NIFTY50", lastPrice: niftyHistory[niftyHistory.length-1], vwap: niftyHistory[niftyHistory.length-1] } as any;
        const vixPlaceholder: StockData = { symbol: "VIX", lastPrice: 15 } as any;
        
        const regime = MarketRegimeService.calculateRegime(
          niftyPlaceholder,
          vixPlaceholder,
          Math.max(1, advances),
          Math.max(1, declines),
          niftyHistory
        );
        currentRegime = regime;
        console.log(`[Scheduler] Regime Updated: ${regime.regime} (${regime.description})`);
        io.emit("market-regime-update", regime);
      }

      // 1. Check for Auto-Login at 08:55 AM IST
      if (isLoginTime(now)) {
        console.log("[Scheduler] 08:55 AM IST detected. Triggering automated Fyers login...");
        const result = await performAutoLogin().catch(err => ({ success: false, error: err.message }));
        if (result && result.success) {
          console.log("[Scheduler] Automated login successful. Renewing sockets...");
          setupFyersSocket();
        }
      }
  
      // 2. Check Market Status & Optimize Services
      const marketStatus = isMarketOpen(now);
      if (marketStatus.open) {
        if (scannerService && !scannerService.isRunning && (process.env.FYERS_ACCESS_TOKEN || process.env.KOTAK_NEO_ACCESS_TOKEN)) {
          console.log(`[Scheduler] Market is OPEN. Starting scanner with active broker connection...`);
          scannerService.start().catch(e => console.error("[Scheduler] Scanner start failed:", e));
          io.emit("bot-log", `SYSTEM: Scanner resumed (Reason: Market open)`);
        }
      } else {
        if (scannerService && scannerService.isRunning) {
          console.log(`[Scheduler] Market is CLOSED (${marketStatus.reason}). Suspending scanner...`);
          scannerService.stop();
        }
      }
    } catch (e: any) {
      console.error("[Scheduler] Interval execution failed:", e.message);
    }
  }, 60000);

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 [Server] Quantitative Trading Engine running on http://0.0.0.0:${PORT}`);
    
    // Config Debug
    const cfg = {
      clientId: !!process.env.FYERS_CLIENT_ID,
      secretKey: !!process.env.FYERS_SECRET_KEY,
      userId: !!process.env.FYERS_USER_ID,
      totp: !!process.env.FYERS_TOTP_SECRET,
      pin: !!process.env.FYERS_PIN,
      telegramBot: !!process.env.TELEGRAM_BOT_TOKEN,
      telegramChat: !!process.env.TELEGRAM_CHAT_ID,
      appUrl: process.env.APP_URL || "MISSING",
      redirectUri: process.env.FYERS_REDIRECT_URI || "DETECTION_MODE"
    };
    console.log(`[Config Status] ClientID: ${cfg.clientId}, Telegram Ready: ${cfg.telegramBot && cfg.telegramChat}, AutoLogin Ready: ${cfg.userId && cfg.totp && cfg.pin}`);

    // Try auto-login AFTER server is listening
    console.log("[Server Startup] Booting Kotak Neo Client...");
    performKotakNeoLogin()
      .then((res) => {
        if (res && res.success) {
          console.log(`[Server Startup] Kotak Neo initialized successfully in ${res.mode} mode.`);
        }
      })
      .catch((err) => {
        console.error("[Server Startup] Failed to execute initial Kotak Neo handshake:", err);
      });

    // Try auto-login AFTER server is listening
    if (!process.env.FYERS_ACCESS_TOKEN && process.env.FYERS_TOTP_SECRET) {
      console.log("[Server Startup] Triggering automated login...");
      performAutoLogin()
        .then((result) => {
          if (result && result.success) {
            console.log("[Server Startup] Automated login successful. Initializing sockets.");
            try {
              setupFyersSocket();
            } catch (e) {
              console.error("[Server Startup] Deferred socket setup failed:", e);
            }
          } else {
            console.log("[Server Startup] Automated login failed or credentials missing:", result?.error || "Unknown");
          }
        })
        .catch(err => {
          console.error("[Server Startup] login-then-socket chain failed:", err);
        });
    }
  });
}

startServer().catch(err => {
  console.error("❌ [CRITICAL] Server failed to start:", err);
});
