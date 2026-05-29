import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import dotenv from "dotenv";
import { Server } from "socket.io";
import http from "http";
import crypto from "crypto";
import speakeasy from "speakeasy";
import readline from "readline";
import { ScannerService, TradeSignal } from "./src/services/scannerService";
import { PaperTradingService } from "./src/services/paperTradingService";
import { BreakoutStrategyService } from "./src/services/breakoutStrategyService";
import { isMarketOpen, isLoginTime } from "./src/services/marketHoursService";
import { MarketRegimeService } from "./src/services/marketRegimeService";
import { MarketRegime, StockData, Trend } from "./src/types";
import { FNO_SYMBOLS } from "./src/services/fnoData";
import { getLiveStockData } from "./src/services/nseService";

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

let loginPromise: Promise<any> | null = null;
let scannerService: ScannerService | null = null;
let tradingService: PaperTradingService | null = null;
let breakoutStrategyService: BreakoutStrategyService | null = null;
let lastDhanAutoLoginDate = "";
let lastBreakoutScanDate = "";

// Dhan Connection and Auth Tracking
let isDhanConnected = false;
let isDhanScripLoaded = false;
const dhanScripMap = new Map<string, string>(); // Ticker/Option -> securityId
const dhanLotSizeMap = new Map<string, number>(); // Underlying symbol -> F&O lot size
const dhanUnderlyingIdMap = new Map<string, string>(); // Equity underlying -> NSE_EQ securityId (for option chain)

// Robust CSV line splitter: respects double-quoted fields that contain commas.
// Dhan's scrip master has commas inside SEM_CUSTOM_SYMBOL, which a naive split() corrupts.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// Lazy load Dhan Master CSV with enhanced error handling
async function loadDhanScripMaster() {
  try {
    console.log("[Dhan] 🔍 Downloading detailed scrip master from CDN...");
    const response = await axios({
      method: "get",
      // Detailed master exposes SEM_SMST_SECURITY_ID (the ID the API expects),
      // SEM_LOT_UNITS, instrument type and expiry — needed for stock options.
      url: "https://images.dhan.co/api-data/api-scrip-master-detailed.csv",
      responseType: "stream",
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.data) {
      throw new Error("Empty CSV response from Dhan CDN");
    }

    const rl = readline.createInterface({
      input: response.data,
      crlfDelay: Infinity
    });

    let index = 0;
    let headers: string[] = [];
    let parseErrors = 0;
    let successCount = 0;

    for await (const line of rl) {
      try {
        if (index === 0) {
          headers = parseCsvLine(line);
          console.log(`[Dhan] CSV Headers: ${headers.slice(0, 6).join(", ")}...`);
          index++;
          continue;
        }

        const parts = parseCsvLine(line);
        if (parts.length < 2) continue;

        const row: Record<string, string> = {};
        headers.forEach((h, idx) => {
          row[h] = parts[idx] ?? "";
        });

        // Symbol: trading symbol for derivatives, plain symbol for equities
        const symbol = row["SEM_TRADING_SYMBOL"]
          || row["SEM_CUSTOM_SYMBOL"]
          || row["SM_SYMBOL_NAME"]
          || row["SYMBOL"]
          || row["Trading Symbol"];

        // SEM_SMST_SECURITY_ID is THE id the Dhan API expects. Prefer it.
        const id = row["SEM_SMST_SECURITY_ID"]
          || row["SEM_SM_ID"]
          || row["SEM_EXCH_INSTRUMENT_ID"]
          || row["Security ID"]
          || row["Instrument ID"];

        const segment = (row["SEM_SEGMENT"] || row["SEM_EXM_EXCH_ID"] || "").toUpperCase();
        const instrument = (row["SEM_INSTRUMENT_NAME"] || row["SEM_EXCH_INSTRUMENT_TYPE"] || "").toUpperCase();
        const underlying = (row["SEM_UNDERLYING"] || row["SM_SYMBOL_NAME"] || "").toUpperCase().trim();
        const lotUnits = Number(row["SEM_LOT_UNITS"] || row["Lot Size"] || 0);

        if (symbol && id) {
          const cleanId = id.trim();
          const cleanSymbol = symbol.toUpperCase().trim();

          dhanScripMap.set(cleanSymbol, cleanId);
          const compact = cleanSymbol.replace(/\s+/g, "");
          dhanScripMap.set(compact, cleanId);
          dhanScripMap.set(`NSE:${compact}`, cleanId);
          dhanScripMap.set(`NSE:${compact}-EQ`, cleanId);

          // Capture equity underlying security IDs (for Option Chain API lookups)
          if (instrument.includes("EQUITY") || instrument === "ES" || (segment.includes("NSE") && instrument.includes("EQ"))) {
            dhanUnderlyingIdMap.set(compact, cleanId);
          }

          // Capture F&O lot size keyed by underlying
          if (lotUnits > 0 && underlying) {
            dhanLotSizeMap.set(underlying.replace(/\s+/g, ""), lotUnits);
          }

          successCount++;
        }
        index++;
      } catch (lineErr: any) {
        parseErrors++;
        if (parseErrors < 5) console.warn(`[Dhan] Line ${index} parse error:`, lineErr.message);
      }
    }

    isDhanScripLoaded = true;
    console.log(`[Dhan] ✅ Scrip Master loaded: ${successCount} symbols, ${dhanLotSizeMap.size} lot-sizes, ${dhanUnderlyingIdMap.size} underlyings (${parseErrors} errors skipped)`);

  } catch (err: any) {
    console.error("[Dhan] ⚠️  CSV Download Failed:", err.message);

    // EXPANDED: Fallback with comprehensive scrip list
    const fallbackScrips: Record<string, string> = {
      // Indices
      "NIFTY50": "13", "NIFTY": "13", "BANKNIFTY": "25", "NIFTYBANK": "25", "INDIAVIX": "37",

      // Large Cap
      "RELIANCE": "11536", "HDFCBANK": "1333", "ICICIBANK": "4963", "SBIN": "3045",
      "INFY": "1594", "TCS": "11532", "AXISBANK": "5900", "KOTAKBANK": "1922", "SUNPHARMA": "7263",
      "WIPRO": "5885", "LT": "5991",

      // Mid/Small Cap
      "ASIANPAINT": "875", "MARUTI": "2675", "M&M": "2030",
      "TATAMOTORS": "8718", "HEROMOTOCO": "5787", "TITAN": "7315", "CHOLAFIN": "3262",
      "BAJAJ-AUTO": "8401", "EICHERMOT": "5356", "JINDALSTEL": "6280"
    };

    Object.entries(fallbackScrips).forEach(([k, v]) => {
      dhanScripMap.set(k, v);
      dhanScripMap.set(`NSE:${k}`, v);
      dhanScripMap.set(`${k}-EQ`, v);
      dhanScripMap.set(`NSE:${k}-EQ`, v);
    });

    isDhanScripLoaded = true;
    console.log(`[Dhan] 📦 Using fallback scrip index (${Object.keys(fallbackScrips).length} symbols)`);
  }
}

// Regional/Global State for Market Context
let niftyHistory: number[] = [];
let currentRegime: any = { regime: MarketRegime.SIDEWAYS, description: "Initializing regime analyzer..." };
let advances = 0;
let declines = 0;

function generateTOTP(secretBase32: string): string {
  // Dhan validates the TOTP server-side with a tight window. The #1 cause of
  // "TOTP Validation Failed" is host clock drift on cloud containers — keep the
  // server clock synced (NTP). step:30 is the standard authenticator period.
  return speakeasy.totp({ secret: secretBase32, encoding: "base32", step: 30 });
}

async function generateDhanToken(clientId: string, userPin: string, totpKey: string) {
  try {
    const totp = generateTOTP(totpKey);
    const url = `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${clientId}&pin=${userPin}&totp=${totp}`;
    console.log(`[Dhan] 🔐 Generating token for Client ID: ${clientId}`);
    const response = await axios.post(url, {}, { headers: { "Content-Type": "application/json", "Accept": "application/json" }, timeout: 15000 });
    const data = response.data;
    const token = data.accessToken || data.access_token || data.token || data.Token;
    return token ? { success: true, token } : { success: false, error: data.message || data.error || "No token in response" };
  } catch (err: any) {
    const msg = err.response?.data?.message || err.response?.data?.errorValue || err.response?.data?.error || err.message;
    console.error("[Dhan] ❌ Token generation error:", msg);
    return { success: false, error: msg };
  }
}

// Auto-run Dhan login on startup
async function attemptDhanAutoLoginFromEnv(): Promise<{ success: boolean; token?: string; error?: string }> {
  let clientId = process.env.DHAN_CLIENT_ID;
  let totpKey = process.env.DHAN_TOTP_KEY;
  let userPin = process.env.DHAN_USER_PIN;

  // Check JSON file if env vars are missing or if it has a valid token
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const credsPath = path.join(process.cwd(), "dhan-credentials.json");
    const fileExists = await fs.access(credsPath).then(() => true).catch(() => false);
    if (fileExists) {
      const raw = await fs.readFile(credsPath, "utf8");
      const creds = JSON.parse(raw);

      // Dhan tokens are valid 24h (SEBI rule). Reuse a cached token until it is
      // close to expiry, then regenerate via TOTP.
      if (creds.accessToken && creds.tokenDate) {
        const ageHrs = (Date.now() - creds.tokenDate) / (1000 * 60 * 60);
        if (ageHrs < 20) {
          console.log(`[Dhan] ♻️  Using valid cached token (Age: ${ageHrs.toFixed(2)} hrs)`);
          process.env.DHAN_ACCESS_TOKEN = creds.accessToken;
          process.env.DHAN_CLIENT_ID = creds.clientId || clientId;
          isDhanConnected = true;
          return { success: true, token: creds.accessToken };
        }
      }

      clientId = clientId || creds.clientId;
      totpKey = totpKey || creds.totpKey;
      userPin = userPin || creds.userPin;
    }
  } catch (e: any) {
    console.warn("[Dhan] Could not read credentials file:", e.message);
  }

  if (clientId && totpKey && userPin) {
    console.log(`[Dhan] 🔄 Generating automated token for Client ID: ${clientId}`);
    const result = await generateDhanToken(clientId, userPin, totpKey);

    if (result.success && result.token) {
      console.log(`[Dhan] ✅ Automated login succeeded!`);
      process.env.DHAN_ACCESS_TOKEN = result.token;
      process.env.DHAN_CLIENT_ID = clientId;
      isDhanConnected = true;

      // Persist token to cache file
      try {
        const fs = await import("fs/promises");
        const path = await import("path");
        const credsPath = path.join(process.cwd(), "dhan-credentials.json");
        const creds = { clientId, userPin, totpKey, accessToken: result.token, tokenDate: Date.now() };
        await fs.writeFile(credsPath, JSON.stringify(creds, null, 2), "utf8");
      } catch (saveErr) {
        console.warn("[Dhan] Could not persist token to cache:", saveErr);
      }

      return { success: true, token: result.token };
    } else {
      console.error(`[Dhan] ❌ Token generation failed: ${result.error}`);
      return { success: false, error: result.error || "Token generation failed" };
    }
  }

  // Fallback to manual API key
  if (process.env.DHAN_ACCESS_TOKEN) {
    console.log(`[Dhan] 🔑 Using manual DHAN_ACCESS_TOKEN from environment`);
    isDhanConnected = true;
    return { success: true, token: process.env.DHAN_ACCESS_TOKEN };
  }

  return { success: false, error: "No valid Dhan credentials found in environment or file" };
}

let lastValidationTime = 0;
async function validateAndRefreshToken(): Promise<boolean> {
  const token = process.env.DHAN_ACCESS_TOKEN;
  if (!token) {
    console.error("[Dhan] ❌ No token in environment");
    return false;
  }

  // Throttle validation to prevent spamming
  if (Date.now() - lastValidationTime < 60000) return true;

  try {
    const response = await axios.get("https://api.dhan.co/v2/fundlimit", {
      headers: { 
        "access-token": token, 
        "client-id": process.env.DHAN_CLIENT_ID || "",
        "Content-Type": "application/json"
      },
      timeout: 5000
    });
    
    console.log("[Dhan] ✅ Token validated. Available margin:", response.data?.availableMargin || response.data?.margin);
    lastValidationTime = Date.now();
    return true;
  } catch (err: any) {
    const status = err.response?.status;
    const errData = err.response?.data;

    console.error(`[Dhan] ❌ Token validation failed (${status}):`, errData?.message || err.message);

    if (status === 401 || status === 403) {
      console.log("[Dhan] 🔄 Token expired. Attempting refresh...");
      const result = await attemptDhanAutoLoginFromEnv();
      return result.success;
    }

    if (status === 429) {
      console.warn("[Dhan] 🚫 Rate limited (429). Will retry later...");
      return false;
    }

    return false;
  }
}

// Resolve F&O lot size for an underlying from the loaded scrip master.
function resolveLotSize(underlying: string): number | null {
  const key = underlying.toUpperCase().replace(/\s+/g, "");
  return dhanLotSizeMap.get(key) || null;
}

export interface DhanOrderRequest {
  symbol: string;                 // option trading symbol or equity symbol
  securityId?: string;            // pre-resolved id (preferred for derivatives)
  side: "BUY" | "SELL";
  qty: number;
  orderType?: "MARKET" | "LIMIT";
  price?: number;
  productType?: "INTRADAY" | "MARGIN" | "CNC";
  segment?: string;               // optional override
  underlying?: string;            // for lot-size validation on options
}

export interface DhanOrderResult {
  success: boolean;
  orderId?: string;
  message: string;
  details?: any;
}

// Single, safe path for placing a REAL order on Dhan.
// Guarantees: never guesses a securityId, never reports a failed order as success.
async function placeDhanOrder(o: DhanOrderRequest): Promise<DhanOrderResult> {
  const token = process.env.DHAN_ACCESS_TOKEN;
  const clientId = process.env.DHAN_CLIENT_ID;
  if (!token || !clientId) {
    return { success: false, message: "Dhan not connected (missing access token or client id)." };
  }

  const cleanSymbol = String(o.symbol).replace("NSE:", "").trim().toUpperCase();
  const isDerivative = /(CE|PE)$/.test(cleanSymbol) || /FUT$/.test(cleanSymbol);
  const segment = o.segment || (isDerivative ? "NSE_FNO" : "NSE_EQ");

  // Resolve security id — NEVER guess. A wrong id means a wrong instrument is traded.
  const securityId = o.securityId
    || dhanScripMap.get(cleanSymbol)
    || dhanScripMap.get(cleanSymbol.replace(/\s+/g, ""));
  if (!securityId) {
    return {
      success: false,
      message: `Refusing to place order: no Dhan securityId resolved for "${o.symbol}". (Scrip master not loaded, or symbol format mismatch.)`
    };
  }

  // Lot-size validation for derivatives (best-effort; only blocks when we are sure)
  if (isDerivative) {
    const underlying = o.underlying || cleanSymbol.replace(/[-\s]?\d.*$/, "");
    const lot = resolveLotSize(underlying);
    if (lot && Number(o.qty) % lot !== 0) {
      return {
        success: false,
        message: `Quantity ${o.qty} is not a multiple of the ${underlying} lot size (${lot}). Use ${lot}, ${lot * 2}, ${lot * 3}, ...`
      };
    }
  }

  const orderType = o.orderType || "MARKET";
  const payload = {
    dhanClientId: clientId,
    correlationId: `QO${Date.now().toString().slice(-8)}`,
    transactionType: o.side,
    exchangeSegment: segment,
    // Intraday options-buying default. Carry-forward would use MARGIN.
    productType: o.productType || "INTRADAY",
    orderType,
    validity: "DAY",
    securityId: String(securityId),
    quantity: Number(o.qty),
    disclosedQuantity: 0,
    price: orderType === "LIMIT" ? Number(o.price || 0) : 0,
    triggerPrice: 0,
    afterMarketOrder: false
  };

  try {
    const resp = await axios.post("https://api.dhan.co/v2/orders", payload, {
      headers: { "access-token": token, "client-id": clientId, "Content-Type": "application/json" },
      timeout: 7000
    });
    const data = resp.data || {};
    const orderId = data.orderId || data.orderID;
    if (orderId && data.orderStatus !== "REJECTED") {
      return { success: true, orderId: String(orderId), message: `Order accepted by Dhan (status: ${data.orderStatus || "TRANSIT"}).`, details: data };
    }
    // Reached Dhan but rejected — this is a FAILURE, surface it.
    return { success: false, message: data.omsErrorDescription || data.remarks || "Order rejected by Dhan.", details: data };
  } catch (err: any) {
    const msg = err.response?.data?.errorMessage || err.response?.data?.errorValue || err.response?.data?.message || err.message;
    console.error("[Order] ❌ Dhan order failed:", msg);
    return { success: false, message: `Order failed at Dhan: ${msg}`, details: err.response?.data };
  }
}

// ---- Dhan Option Chain (real OI, IV, Greeks, per-strike security IDs) ----
const optionChainCache = new Map<string, { ts: number; data: any }>();
const expiryCache = new Map<string, { ts: number; data: string[] }>();

async function getDhanExpiryList(underlyingScrip: number, underlyingSeg: string): Promise<string[]> {
  const token = process.env.DHAN_ACCESS_TOKEN, clientId = process.env.DHAN_CLIENT_ID;
  if (!token || !clientId) return [];
  const key = `${underlyingScrip}:${underlyingSeg}`;
  const cached = expiryCache.get(key);
  if (cached && Date.now() - cached.ts < 60000) return cached.data;
  try {
    const resp = await axios.post("https://api.dhan.co/v2/optionchain/expirylist",
      { UnderlyingScrip: underlyingScrip, UnderlyingSeg: underlyingSeg },
      { headers: { "access-token": token, "client-id": clientId, "Content-Type": "application/json" }, timeout: 7000 });
    const list: string[] = resp.data?.data || [];
    expiryCache.set(key, { ts: Date.now(), data: list });
    return list;
  } catch (e: any) {
    console.warn("[OptionChain] expiry list failed:", e.response?.data?.errorMessage || e.message);
    return [];
  }
}

async function getDhanOptionChain(underlyingScrip: number, underlyingSeg: string, expiry: string): Promise<any | null> {
  const token = process.env.DHAN_ACCESS_TOKEN, clientId = process.env.DHAN_CLIENT_ID;
  if (!token || !clientId) return null;
  const key = `${underlyingScrip}:${underlyingSeg}:${expiry}`;
  const cached = optionChainCache.get(key);
  // Dhan rate-limits this API to 1 unique request / 3s — serve cached within that window.
  if (cached && Date.now() - cached.ts < 3500) return cached.data;
  try {
    const resp = await axios.post("https://api.dhan.co/v2/optionchain",
      { UnderlyingScrip: underlyingScrip, UnderlyingSeg: underlyingSeg, Expiry: expiry },
      { headers: { "access-token": token, "client-id": clientId, "Content-Type": "application/json" }, timeout: 8000 });
    const data = resp.data?.data || null;
    if (data) optionChainCache.set(key, { ts: Date.now(), data });
    return data;
  } catch (e: any) {
    console.warn("[OptionChain] fetch failed:", e.response?.data?.errorMessage || e.message);
    return null;
  }
}

export interface ResolvedOptionLeg {
  underlying: string; expiry: string; strike: number; spot: number;
  optionType: "CE" | "PE"; securityId: string; ltp: number;
  oi: number; previousOi: number; iv: number;
  greeks: { delta: number; theta: number; gamma: number; vega: number };
  bid: number; ask: number; volume: number;
}

// Resolve a tradable option leg for a STOCK underlying with live OI/IV/Greeks.
// strikeOffset: 0 = ATM, +1/-1 = one strike OTM/ITM step (caller's convention).
async function resolveStockOptionLeg(
  underlyingSymbol: string,
  optionType: "CE" | "PE",
  strikeOffset = 0,
  preferExpiry?: string
): Promise<ResolvedOptionLeg | null> {
  const u = underlyingSymbol.toUpperCase().replace("NSE:", "").replace(/-EQ$/, "").replace(/\s+/g, "");
  const scrip = Number(dhanUnderlyingIdMap.get(u) || dhanScripMap.get(u) || dhanScripMap.get(`NSE:${u}`));
  if (!scrip) { console.warn(`[OptionChain] no underlying securityId for ${u}`); return null; }

  const seg = "NSE_EQ"; // stock options: underlying is the cash equity
  const expiries = await getDhanExpiryList(scrip, seg);
  if (!expiries.length) return null;
  const expiry = preferExpiry && expiries.includes(preferExpiry) ? preferExpiry : expiries[0]; // nearest

  const chain = await getDhanOptionChain(scrip, seg, expiry);
  if (!chain?.oc) return null;
  const spot = Number(chain.last_price) || 0;

  const strikeKeys = Object.keys(chain.oc);
  const strikes = strikeKeys.map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (!strikes.length) return null;

  // ATM = nearest strike to spot
  let atmIdx = 0, bestDiff = Infinity;
  strikes.forEach((s, i) => { const d = Math.abs(s - spot); if (d < bestDiff) { bestDiff = d; atmIdx = i; } });
  // Apply offset (CE OTM = higher strike, PE OTM = lower strike)
  const dir = optionType === "CE" ? 1 : -1;
  const chosenIdx = Math.min(Math.max(atmIdx + strikeOffset * dir, 0), strikes.length - 1);
  const strike = strikes[chosenIdx];

  const matchKey = strikeKeys.find(k => Number(k) === strike) || strike.toFixed(6);
  const leg = chain.oc[matchKey]?.[optionType.toLowerCase()];
  if (!leg || !leg.security_id) return null;

  return {
    underlying: u, expiry, strike, spot, optionType,
    securityId: String(leg.security_id),
    ltp: Number(leg.last_price) || 0,
    oi: Number(leg.oi) || 0,
    previousOi: Number(leg.previous_oi) || 0,
    iv: Number(leg.implied_volatility) || 0,
    greeks: {
      delta: Number(leg.greeks?.delta) || 0,
      theta: Number(leg.greeks?.theta) || 0,
      gamma: Number(leg.greeks?.gamma) || 0,
      vega: Number(leg.greeks?.vega) || 0,
    },
    bid: Number(leg.top_bid_price) || 0,
    ask: Number(leg.top_ask_price) || 0,
    volume: Number(leg.volume) || 0,
  };
}

async function startServer() {
  console.log("\n" + "━".repeat(70));
  console.log("[SERVER] Initializing QuantOptix Trading Engine");
  console.log("━".repeat(70));

  const app = express();
  const httpServer = http.createServer(app);

  // STARTUP CHECK: Validate Dhan Configuration
  console.log("\n[STARTUP] Dhan Configuration Check:");
  console.log("━".repeat(70));

  const hasToken = !!process.env.DHAN_ACCESS_TOKEN;
  const hasAutoLogin = !!(process.env.DHAN_CLIENT_ID && process.env.DHAN_TOTP_KEY && process.env.DHAN_USER_PIN);

  console.log(`  Token Present: ${hasToken ? "✅ YES" : "❌ NO"}`);
  console.log(`  Auto-login Config: ${hasAutoLogin ? "✅ YES" : "❌ NO"}`);

  if (!hasToken && !hasAutoLogin) {
    console.error("\n⚠️  WARNING: No Dhan authentication configured!");
    console.error("   Please set either:");
    console.error("   - DHAN_ACCESS_TOKEN (manual token from web.dhan.co, valid 24 hours)");
    console.error("   - DHAN_CLIENT_ID + DHAN_TOTP_KEY + DHAN_USER_PIN (auto-login)");
    console.error("\n   The app will run in SIMULATION MODE only.\n");
  } else {
    console.log("\n[STARTUP] Attempting Dhan connection...");
    const loginResult = await attemptDhanAutoLoginFromEnv();
    if (loginResult.success) {
      console.log("✅ Dhan connection verified!");
      isDhanConnected = true;
    } else {
      console.error("❌ Dhan connection failed:", loginResult.error);
    }
  }

  console.log("━".repeat(70) + "\n");

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
  // Wire the strategy to the single safe Dhan order path + live option-chain resolver.
  // The strategy itself stays broker-agnostic; all live execution flows through here.
  breakoutStrategyService.setOrderExecutor(placeDhanOrder);
  breakoutStrategyService.setOptionResolver(resolveStockOptionLeg);

  // Trigger lazy download of Dhan master CSV in background
  loadDhanScripMaster().catch(e => console.error("[Dhan] Master download error:", e));

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
        console.error("[Telegram] Failed to send notification:", e.message);
      }
    }
  };

  scannerService.onSignal = (signal) => {
    if (tradingService) {
      tradingService.handleSignal(signal);
    }
  };

  const PORT = Number(process.env.PORT) || 3000;

  // Real-time Stock and Option quote background broadcaster
  setInterval(async () => {
    try {
      const symbolsToStream = [
        "NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "NSE:INDIAVIX-INDEX",
        "NSE:RELIANCE-EQ", "NSE:HDFCBANK-EQ", "NSE:ICICIBANK-EQ", "NSE:SBIN-EQ", "NSE:INFY-EQ",
        "NSE:TCS-EQ", "NSE:AXISBANK-EQ", "NSE:KOTAKBANK-EQ", "NSE:TATAMOTORS-EQ", "NSE:LT-EQ"
      ];

      // Add target breakout scan symbols dynamically if Strategy is active
      if (breakoutStrategyService && breakoutStrategyService.isEnabled && breakoutStrategyService.targets) {
        breakoutStrategyService.targets.forEach((t: any) => {
          if (t.symbol && !symbolsToStream.includes(`NSE:${t.symbol}-EQ`)) {
            symbolsToStream.push(`NSE:${t.symbol}-EQ`);
          }
          if (t.optionSymbol && !symbolsToStream.includes(t.optionSymbol)) {
            symbolsToStream.push(t.optionSymbol);
          }
        });
      }

      let quotes: any[] = [];
      try {
        quotes = await getDirectQuotes(symbolsToStream);
      } catch (e) {
        quotes = symbolsToStream.map(sym => generateMockQuoteItem(sym));
      }

      quotes.forEach(quote => {
        if (!quote) return;
        const msg = {
          symbol: quote.n,
          ltp: quote.v.lp,
          high_price: quote.v.high,
          low_price: quote.v.low,
          ch: quote.v.ch,
          chp: quote.v.chp,
          volume: quote.v.vol,
          v: quote.v.vol,
          avg_price: quote.v.avg_price || quote.v.lp
        };

        // Broadcast to all Socket.io clients
        io.emit("market-update", msg);

        // Update Context: Nifty & Breadth
        if (quote.n === "NSE:NIFTY50-INDEX" && quote.v.lp) {
          const ltp = quote.v.lp;
          if (niftyHistory.length === 0 || ltp !== niftyHistory[niftyHistory.length - 1]) {
            niftyHistory.push(ltp);
            if (niftyHistory.length > 50) niftyHistory.shift();
          }
        }

        // Pipe to scanner and trading engine
        if (msg.symbol && msg.ltp) {
          if (msg.symbol.includes('-EQ')) {
            if (msg.chp > 0) advances++;
            else if (msg.chp < 0) declines++;
            if (advances + declines > 1000) { advances *= 0.5; declines *= 0.5; }
          }

          if (scannerService && scannerService.isRunning) {
            scannerService.handleTick(
              msg.symbol,
              msg.ltp,
              msg.high_price,
              msg.low_price,
              msg.v
            );
          }
          if (tradingService) {
            tradingService.updatePnL(msg.symbol, msg.ltp);
          }
          if (breakoutStrategyService) {
            const tempMap: Record<string, any> = {};
            tempMap[msg.symbol] = {
              lp: msg.ltp,
              avg_price: msg.avg_price,
              chp: msg.chp
            };
            breakoutStrategyService.handleTickUpdates(tempMap);
          }
        }
      });
    } catch (err: any) {
      console.error("[Broadcaster] Tick stream error:", err.message);
    }
  }, 1000);

  // Auto-start Scanner Service immediately on startup
  if (scannerService) {
    scannerService.start().catch(e => console.error("[Scanner] Auto-start error:", e));
  }

  app.use(express.json());

  // Logging middleware
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      console.log(`[API] ${req.method} ${req.path}`);
    }
    next();
  });

  // Health check
  app.get("/api/health", async (req, res) => {
    const allEnvKeys = Object.keys(process.env);
    const dhanKeys = allEnvKeys.filter(k => k.toUpperCase().includes('DHAN'));

    let publicIp = "unknown";
    try {
      const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 2000 });
      publicIp = ipRes.data.ip;
    } catch (e: any) {
      console.warn("[Health] Could not fetch public IP:", e.message);
    }

    res.json({
      status: "alive",
      time: new Date().toISOString(),
      publicIp,
      tokenPresent: !!process.env.DHAN_ACCESS_TOKEN,
      dhanConnected: isDhanConnected,
      dhanScripLoaded: isDhanScripLoaded,
      dhanScripCount: dhanScripMap.size,
      clientIdPresent: !!process.env.DHAN_CLIENT_ID,
      dhanKeysFound: dhanKeys,
      appUrl: process.env.APP_URL || "NOT_SET",
      telegramConfigured: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID,
      telegramKeysFound: allEnvKeys.filter(k => k.includes('TELEGRAM'))
    });
  });

  // DHAN AUTHENTICATION AND CONNECT ENDPOINTS
  app.post("/api/auth/dhan/connect", express.json(), async (req, res) => {
    const { token, clientId } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: "Access token is mandatory" });
    }
    if (!clientId) {
      return res.status(400).json({ success: false, message: "Client ID is mandatory (Dhan data & order APIs require the client-id header)." });
    }

    try {
      console.log(`[Dhan] 🔍 Validating connection with Client ID: ${clientId || "Personal Token"}...`);
      const check = await axios.get("https://api.dhan.co/v2/fundlimit", {
        headers: {
          "access-token": token,
          "client-id": clientId,
          "Content-Type": "application/json"
        },
        timeout: 4000
      });

      if (check.status === 200) {
        process.env.DHAN_ACCESS_TOKEN = token;
        if (clientId) process.env.DHAN_CLIENT_ID = clientId;
        isDhanConnected = true;
        console.log("[Dhan] ✅ Token validated successfully!");

        // Load scrips Master index if not yet loaded
        if (dhanScripMap.size < 20) {
          loadDhanScripMaster().catch(e => console.warn("[Dhan] Background scrip reload failed:", e.message));
        }

        return res.json({
          success: true,
          message: "Authorized with Dhan API successfully!",
          funds: check.data
        });
      } else {
        throw new Error("Dhan API rejected the authentication token.");
      }
    } catch (error: any) {
      const status = error.response?.status;
      const msg = error.response?.data?.errorValue || error.response?.data?.message || error.message;
      console.error(`[Dhan] ❌ Validation Error (${status}):`, msg);

      // Do NOT mark connected on failure. A bad/expired token must surface clearly,
      // otherwise the UI shows "connected" while every downstream call fails.
      isDhanConnected = false;

      let hint = msg;
      if (status === 401 || status === 403) {
        hint = "Token rejected by Dhan (expired or invalid). Generate a fresh token at web.dhan.co → My Profile → Access DhanHQ APIs. Tokens are valid for 24 hours.";
      }

      return res.status(401).json({
        success: false,
        message: "Dhan authentication failed.",
        details: hint
      });
    }
  });

  app.post("/api/auth/dhan/trigger-env-login", async (req, res) => {
    try {
      console.log("[Dhan] 🔑 Triggering token generation from environment credentials...");
      const result = await attemptDhanAutoLoginFromEnv();
      if (result.success) {
        if (dhanScripMap.size < 20) {
          loadDhanScripMaster().catch(e => console.warn("[Dhan] Background scrip reload failed:", e.message));
        }
        return res.json({
          success: true,
          message: "✅ Dhan Token successfully generated!",
          token: result.token
        });
      } else {
        return res.status(400).json({
          success: false,
          message: result.error || "Auto-generation failed"
        });
      }
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        message: err.message || "Server error generating token"
      });
    }
  });

  app.post("/api/auth/dhan/automate-login", express.json(), async (req, res) => {
    const { clientId, totpKey, userPin, saveCredentials } = req.body;

    if (!clientId || !totpKey || !userPin) {
      return res.status(400).json({ 
        success: false, 
        message: "Client ID, TOTP Key, and PIN are mandatory" 
      });
    }

    try {
      console.log(`[Dhan] 🔐 Initiating automated login for Client ID: ${clientId}...`);
      const fs = await import("fs/promises");
      const result = await generateDhanToken(clientId, userPin, totpKey);

      if (result.success && result.token) {
        // Validate the generated token
        try {
          const testCheck = await axios.get("https://api.dhan.co/v2/fundlimit", {
            headers: {
              "access-token": result.token,
              "client-id": clientId,
              "Content-Type": "application/json"
            },
            timeout: 4000
          });

          if (testCheck.status === 200) {
            process.env.DHAN_ACCESS_TOKEN = result.token;
            process.env.DHAN_CLIENT_ID = clientId;
            isDhanConnected = true;

            if (dhanScripMap.size < 20) {
              loadDhanScripMaster().catch(e => console.warn("[Dhan] Background scrip reload failed:", e.message));
            }

            // Persist automation config if requested
            if (saveCredentials) {
              const creds = { clientId, userPin, totpKey, accessToken: result.token, tokenDate: Date.now() };
              await fs.writeFile(path.join(process.cwd(), "dhan-credentials.json"), JSON.stringify(creds, null, 2), "utf8");
            }

            return res.json({
              success: true,
              message: "✅ Logged in & verified with Dhan!",
              token: result.token,
              funds: testCheck.data
            });
          } else {
            throw new Error("Validation handshake failed");
          }
        } catch (validateErr: any) {
          const errMsg = validateErr.response?.data?.errorValue || validateErr.response?.data?.message || validateErr.message;
          console.warn(`[Dhan] ⚠️  Token generated but verification failed:`, errMsg);

          return res.status(400).json({
            success: false,
            message: `Token generation succeeded but validation failed: ${errMsg}`,
            token: result.token
          });
        }
      } else {
        return res.status(400).json({
          success: false,
          message: result.error || "Token generation unsuccessful"
        });
      }
    } catch (e: any) {
      return res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/auth/dhan/credentials", async (req, res) => {
    try {
      const fs = await import("fs/promises");
      const credsPath = path.join(process.cwd(), "dhan-credentials.json");

      let creds: any = {};
      let configuredFile = false;

      const fileExists = await fs.access(credsPath).then(() => true).catch(() => false);
      if (fileExists) {
        const raw = await fs.readFile(credsPath, "utf8");
        creds = JSON.parse(raw);
        configuredFile = true;
      }

      const envCreds = {
        mobileNo: process.env.DHAN_MOBILE || creds.mobileNo || "",
        clientId: process.env.DHAN_CLIENT_ID || creds.clientId || "",
        apiKey: process.env.DHAN_API_KEY || creds.apiKey || "",
        apiSecret: process.env.DHAN_API_SECRET || creds.apiSecret || "",
        totpKey: process.env.DHAN_TOTP_KEY || creds.totpKey || "",
        userPin: process.env.DHAN_USER_PIN || creds.userPin || ""
      };

      const configuredEnv = !!(envCreds.mobileNo && envCreds.clientId && envCreds.apiKey && envCreds.apiSecret && envCreds.totpKey && envCreds.userPin);
      const configuredToken = !!process.env.DHAN_ACCESS_TOKEN;

      return res.json({
        configured: configuredFile || configuredEnv || configuredToken,
        isUsingEnv: configuredEnv || configuredToken,
        mobileNo: envCreds.mobileNo ? `${envCreds.mobileNo.slice(0, 3)}******${envCreds.mobileNo.slice(-2)}` : "",
        clientId: envCreds.clientId || "",
        apiKey: envCreds.apiKey ? `${envCreds.apiKey.slice(0, 4)}****...` : "",
        apiSecret: envCreds.apiSecret ? "****...****" : "",
        totpKey: envCreds.totpKey ? "****...****" : "",
        userPin: "****"
      });
    } catch (e: any) {
      return res.json({ configured: false, error: e.message });
    }
  });

  app.get("/api/auth/dhan/status", (req, res) => {
    res.json({
      isConnected: isDhanConnected || !!process.env.DHAN_ACCESS_TOKEN,
      mode: isDhanConnected ? "live" : "disconnected",
      clientId: process.env.DHAN_CLIENT_ID || "Personal Token",
      tokenPresent: !!process.env.DHAN_ACCESS_TOKEN,
      scripLoaded: isDhanScripLoaded,
      scripCount: dhanScripMap.size,
      envStatus: {
        DHAN_CLIENT_ID: !!process.env.DHAN_CLIENT_ID,
        DHAN_MOBILE: !!process.env.DHAN_MOBILE,
        DHAN_API_KEY: !!process.env.DHAN_API_KEY,
        DHAN_API_SECRET: !!process.env.DHAN_API_SECRET,
        DHAN_TOTP_KEY: !!process.env.DHAN_TOTP_KEY,
        DHAN_USER_PIN: !!process.env.DHAN_USER_PIN
      }
    });
  });

  // DIAGNOSTICS — tests each Dhan API live and reports the exact error.
  // Visit /api/diagnostics/dhan in a browser to see why data may be simulated.
  app.get("/api/diagnostics/dhan", async (req, res) => {
    const token = process.env.DHAN_ACCESS_TOKEN;
    const clientId = process.env.DHAN_CLIENT_ID;
    const out: any = {
      tokenPresent: !!token,
      clientIdPresent: !!clientId,
      scripMasterLoaded: isDhanScripLoaded,
      scripCount: dhanScripMap.size,
      underlyingCount: dhanUnderlyingIdMap.size,
      usingFallbackScrip: dhanScripMap.size < 100,
      checks: {} as Record<string, any>,
      verdict: ""
    };
    const H = { "access-token": token || "", "client-id": clientId || "", "Content-Type": "application/json" };

    // 1) Auth / trading API (works on basic token)
    try {
      const r = await axios.get("https://api.dhan.co/v2/fundlimit", { headers: H, timeout: 5000 });
      out.checks.auth_fundlimit = { ok: true, status: r.status };
    } catch (e: any) {
      out.checks.auth_fundlimit = { ok: false, status: e.response?.status, error: e.response?.data?.errorMessage || e.response?.data?.errorValue || e.message };
    }

    // 2) Market Quote (DATA API — needs Data subscription)
    try {
      const r = await axios.post("https://api.dhan.co/v2/marketfeed/quote", { NSE_EQ: [1333] }, { headers: H, timeout: 6000 }); // 1333 = HDFCBANK
      out.checks.market_quote = { ok: r.data?.status?.toLowerCase?.() === "success", status: r.status, dhanStatus: r.data?.status };
    } catch (e: any) {
      out.checks.market_quote = { ok: false, status: e.response?.status, error: e.response?.data?.errorMessage || e.response?.data?.errorValue || JSON.stringify(e.response?.data) || e.message };
    }

    // 3) Option Chain expiry list (DATA API — needs Data subscription)
    try {
      const r = await axios.post("https://api.dhan.co/v2/optionchain/expirylist", { UnderlyingScrip: 1333, UnderlyingSeg: "NSE_EQ" }, { headers: H, timeout: 6000 });
      out.checks.option_chain = { ok: Array.isArray(r.data?.data), status: r.status, expiries: (r.data?.data || []).slice(0, 3) };
    } catch (e: any) {
      out.checks.option_chain = { ok: false, status: e.response?.status, error: e.response?.data?.errorMessage || e.response?.data?.errorValue || JSON.stringify(e.response?.data) || e.message };
    }

    // Verdict
    const auth = out.checks.auth_fundlimit?.ok;
    const quote = out.checks.market_quote?.ok;
    const chain = out.checks.option_chain?.ok;
    if (!token || !clientId) out.verdict = "Not connected: missing access token or client id.";
    else if (!auth) out.verdict = "Token/clientId rejected even by the trading API — regenerate the token at web.dhan.co (valid 24h).";
    else if (auth && !quote && !chain) out.verdict = "Auth works but DATA APIs are blocked. Enable the DhanHQ Data API subscription (Dhan web → Profile → DhanHQ APIs / Data Subscription). This is why quotes & option chain are simulated.";
    else if (out.usingFallbackScrip) out.verdict = "Data APIs reachable but the scrip master CSV did not load (using small fallback list), so most F&O symbols can't be resolved. Check container egress to images.dhan.co.";
    else if (quote && chain) out.verdict = "All systems live. If the screen still shows simulated values, re-run a scan during market hours (09:15–15:30 IST on a trading day).";
    else out.verdict = "Partial: see individual checks.";

    res.json(out);
  });

  // Cache map for quotes to prevent rate limits
  const quotesCache = new Map<string, { timestamp: number; data: any }>();
  const CACHE_TTL = 3000;
  let rateLimitBackoffUntil = 0;

  function getStockBasePrice(symbol: string): number {
    const cleanSym = symbol.toUpperCase().replace("NSE:", "").replace("-EQ", "").trim();

    // Indices
    if (cleanSym.includes('NIFTY50') || cleanSym === 'NIFTY') return 24200;
    if (cleanSym.includes('NIFTYBANK') || cleanSym === 'BANKNIFTY') return 52300;
    if (cleanSym.includes('INDIAVIX') || cleanSym === 'VIX') return 13.4;

    const prices: Record<string, number> = {
      'HYUNDAI': 1800, 'RELIANCE': 2950, 'TCS': 3850, 'INFY': 1560,
      'HDFCBANK': 1650, 'ICICIBANK': 1150, 'SBIN': 820, 'AXISBANK': 1120,
      'KOTAKBANK': 1780, 'COFORGE': 5200, 'PERSISTENT': 3600, 'UNOMINDA': 1040,
      'ASTRAL': 2150, 'JUBLFOOD': 465, 'BEL': 270, 'HAL': 3800, 'KPITTECH': 1400,
      'ABB': 5400, 'APOLLOHOSP': 6100, 'CIPLA': 1420, 'DIVISLAB': 3800,
      'GLENMARK': 980, 'AUROPHARMA': 1250, 'WIPRO': 480, 'COALINDIA': 470,
      'ITC': 430, 'BHARTIARTL': 1380, 'TATASTEEL': 160, 'MARUTI': 12200,
      'M&M': 2700, 'L&T': 3550, 'JSWSTEEL': 890, 'ADANIENT': 3100,
      'ADANIPORTS': 1350, 'ULTRACEMCO': 9800, 'GRASIM': 2400, 'SUNPHARMA': 1550,
      'VEDL': 450, 'ONGC': 270, 'NTPC': 360, 'POWERGRID': 310, 'HINDALCO': 630,
      'HEROMOTOCO': 4800, 'TITAN': 3300, 'BAJAJ-AUTO': 9200, 'ASIANPAINT': 2900,
      'EICHERMOT': 4600, 'APOLLOTYRE': 480, 'TATAMOTORS': 950, 'IDFCFIRSTB': 80,
      'GMRAIRPORT': 85, 'PNB': 120, 'SAIL': 150, 'IRFC': 170, 'RECLTD': 520,
      'PFC': 480, 'BHEL': 280, 'GAIL': 200, 'NATIONALUM': 190, 'NMDC': 240,
      'CANBK': 120, 'BANKBARODA': 270, 'TATACOMM': 1850, 'TATACONSUM': 1100,
      'TATAPOWER': 430, 'MUTHOOTFIN': 1700, 'HINDUNILVR': 2450, 'LTTS': 4800,
      'MOTHERSUMI': 250, 'SAMVARDHANA': 250, 'ADANIPOWER': 650, 'DLF': 850,
      'GODREJPROP': 2500, 'ASHOKLEY': 220, 'BALKRISIND': 3100, 'CHOLAFIN': 1400,
      'CONCOR': 950, 'CUMMINSIND': 3300, 'DIXON': 9800, 'HAVELLS': 1600,
      'HDFCLIFE': 580, 'ICICIGI': 1650, 'IND HOTELS': 620, 'INDUSINDBK': 1480,
      'IPCALAB': 1250, 'JINDALSTEL': 950, 'LICHSGFIN': 680, 'LTIM': 4850,
      'MPHASIS': 2400, 'MRF': 125000, 'OFSS': 9800, 'PIDILITIND': 3100,
      'POLYCAB': 6500, 'SHREECEM': 26000, 'SIEMENS': 6500, 'SRF': 2300,
      'TATACHEM': 1050, 'TRENT': 4800, 'VOLTAS': 1400
    };

    if (prices[cleanSym] !== undefined) return prices[cleanSym];

    // Fallback: Deterministic base price
    const hash = cleanSym.split('').reduce((acc: number, char: string) => acc + char.charCodeAt(0), 0);
    const ranges = [150, 350, 750, 1250, 2200, 3200, 4500];
    return ranges[hash % ranges.length] + (hash % 100);
  }

  function parseOptionSymbol(symbolStr: string) {
    const cleanSym = symbolStr.replace("NSE:", "");
    const match = cleanSym.match(/^([A-Z0-9\-]+?)(?:\d{2}[A-Z]{3}|\d{2}[0-9A-Z]{3})?(\d+)(CE|PE|PUT)$/i);
    if (match) {
      let type = match[3].toUpperCase();
      if (type === "PE") type = "PUT";
      return { stock: match[1].toUpperCase(), strike: parseInt(match[2], 10), type };
    }
    return null;
  }

  function isMarketOpenIST(date: Date = new Date()): boolean {
    const istFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const parts = istFormatter.formatToParts(date);
    const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';

    const hours = parseInt(getPart('hour'), 10);
    const minutes = parseInt(getPart('minute'), 10);
    const dayOfWeek = date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });

    if (dayOfWeek === 'Sat' || dayOfWeek === 'Sun') return false;

    const currentTime = hours * 100 + minutes;
    return currentTime >= 915 && currentTime < 1530;
  }

  function generateMockQuoteItem(symbolStr: string): any {
    const closed = !isMarketOpenIST();
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
        basePrice = 45;
      }
    } else {
      basePrice = getStockBasePrice(symbolStr);
      if (!closed) {
        const minutes = new Date().getMinutes();
        const deterministicDrift = Math.sin(minutes / 10) * 0.005;
        basePrice = basePrice * (1 + deterministicDrift);
      }
    }

    const driftOffset = closed ? 0 : (Math.sin('seed'.charCodeAt(0) + new Date().getMinutes()) * basePrice * 0.001);
    const ch = driftOffset;
    const chp = closed ? 0 : ((ch / basePrice) * 100);
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

  // Enhanced quote fetching with better diagnostics
  async function getDirectQuotes(requestedSymbols: string[]): Promise<any[]> {
    const INDEX_MAPPINGS: Record<string, { securityId: string; segment: string }> = {
      "NIFTY50-INDEX": { securityId: "13", segment: "IDX_I" },
      "NIFTYBANK-INDEX": { securityId: "25", segment: "IDX_I" },
      "INDIAVIX-INDEX": { securityId: "37", segment: "IDX_I" },
      "NIFTY50": { securityId: "13", segment: "IDX_I" },
      "NIFTYBANK": { securityId: "25", segment: "IDX_I" },
      "BANKNIFTY": { securityId: "25", segment: "IDX_I" },
      "INDIAVIX": { securityId: "37", segment: "IDX_I" },
      "VIX": { securityId: "37", segment: "IDX_I" }
    };

    const token = process.env.DHAN_ACCESS_TOKEN;

    if (!token) {
      console.warn("[Quotes] ❌ No token available. Using mock data.");
      return requestedSymbols.map(sym => generateMockQuoteItem(sym));
    }

    if (!isDhanScripLoaded) {
      console.warn("[Quotes] ⚠️  Scrip master not loaded. Awaiting load...");
      await loadDhanScripMaster();
    }

    try {
      const isValid = await validateAndRefreshToken();
      if (!isValid) {
        console.error("[Quotes] ❌ Token validation failed. Using cached/mock data.");
        return requestedSymbols.map(sym => {
          const cached = quotesCache.get(sym);
          if (cached && (Date.now() - cached.timestamp < 30000)) {
            return cached.data;
          }
          return generateMockQuoteItem(sym);
        });
      }

      const payload: Record<string, any[]> = {};
      const symbolMap = new Map<number, string>();

      requestedSymbols.forEach(sym => {
        const clean = sym.replace("NSE:", "").toUpperCase().replace(/-EQ$/, "");

        // 1) Indices -> IDX_I with their fixed security IDs
        const idx = INDEX_MAPPINGS[clean] || INDEX_MAPPINGS[sym.toUpperCase()];
        let segment: string;
        let securityId: string | undefined;

        if (idx) {
          segment = idx.segment;          // IDX_I
          securityId = idx.securityId;
        } else {
          securityId = dhanScripMap.get(clean) || dhanScripMap.get(sym.toUpperCase());
          // Option/Future trading symbols live in NSE_FNO, cash equities in NSE_EQ
          segment = /(CE|PE)$/.test(clean) || /FUT$/.test(clean) ? "NSE_FNO" : "NSE_EQ";
        }

        if (!securityId) {
          // Never substitute a guessed ID — that returns the wrong instrument's
          // data. Skip; the response builder will mark it unresolved/mock.
          console.warn(`[Quotes] ⚠️  No securityId for: ${sym} (skipping)`);
          return;
        }

        if (!payload[segment]) payload[segment] = [];
        const idNum = Number(securityId);
        payload[segment].push(idNum);
        symbolMap.set(idNum, sym);
      });

      console.log(`[Quotes] 🔍 Fetching ${requestedSymbols.length} symbols...`);

      if (Object.keys(payload).length === 0) {
        console.warn("[Quotes] ⚠️  No valid instruments to fetch");
        return requestedSymbols.map(sym => generateMockQuoteItem(sym));
      }

      if (Date.now() < rateLimitBackoffUntil) {
        console.warn(`[Quotes] ⏸️  Rate limit backoff active. Using cached data.`);
        return requestedSymbols.map(sym => {
          const cached = quotesCache.get(sym);
          return cached ? cached.data : generateMockQuoteItem(sym);
        });
      }

      const response = await axios.post("https://api.dhan.co/v2/marketfeed/quote", payload, {
        headers: {
          "access-token": token,
          "client-id": process.env.DHAN_CLIENT_ID || "1000000000",
          "Content-Type": "application/json"
        },
        timeout: 6000
      });

      if (!response.data) {
        throw new Error("Empty response from Dhan API");
      }

      console.log(`[Quotes] ✅ Response received. Status: ${response.data.status}`);

      const fetchedStockDataMap = new Map<string, any>();

      if (response.data.status === "success" || response.data.status === "SUCCESS") {
        const returnedData = response.data.data;
        if (returnedData) {
          Object.keys(returnedData).forEach(seg => {
            const segData = returnedData[seg];
            if (segData && typeof segData === "object" && !Array.isArray(segData)) {
              Object.keys(segData).forEach(itemId => {
                const itemQuote = segData[itemId];
                if (itemQuote) {
                  fetchedStockDataMap.set(String(itemId), itemQuote);
                }
              });
            }
          });
        }
      }

      let sumPChange = 0;
      let validStockCount = 0;

      fetchedStockDataMap.forEach((item) => {
        const lp = Number(item.lastPrice || item.last_price || item.ltp || item.lp || 0);
        if (lp > 0) {
          const prevClose = item.ohlc?.close || 0;
          if (prevClose > 0) {
            const pChange = ((lp - prevClose) / prevClose) * 100;
            sumPChange += pChange;
            validStockCount++;
          }
        }
      });

      let avgChangePct = 0;
      if (validStockCount > 0) {
        avgChangePct = sumPChange / validStockCount;
      } else {
        const minutes = new Date().getMinutes();
        avgChangePct = 0.24 + Math.sin(minutes / 10) * 0.15;
      }

      return requestedSymbols.map(sym => {
        let clean = sym.replace("NSE:", "").toUpperCase();
        if (clean.endsWith("-EQ")) clean = clean.replace("-EQ", "");

        let securityId = "";
        const iMap = INDEX_MAPPINGS[clean] || INDEX_MAPPINGS[sym.toUpperCase()];
        if (iMap) {
          securityId = iMap.securityId;
        } else {
          securityId = dhanScripMap.get(clean) || dhanScripMap.get(sym.toUpperCase()) || "";
        }

        // Index simulation
        if (iMap && iMap.segment === "IDX_I") {
          const basePrice = getStockBasePrice(sym);
          const lp = basePrice * (1 + avgChangePct / 100);
          const ch = lp - basePrice;
          const chp = avgChangePct;

          const resItem = {
            n: sym,
            s: "ok",
            v: {
              lp: Number(lp.toFixed(2)),
              ch: Number(ch.toFixed(2)),
              chp: Number(chp.toFixed(2)),
              vol: Math.floor(5000000 + Math.random() * 2000000),
              oi: 0,
              oic: 0,
              avg_price: lp,
              high: Number((lp * 1.005).toFixed(2)),
              low: Number((lp * 0.995).toFixed(2)),
              open: basePrice,
              prev_close: basePrice
            }
          };

          quotesCache.set(sym, { timestamp: Date.now(), data: resItem });
          return resItem;
        }

        // Regular stocks
        const match = fetchedStockDataMap.get(String(securityId));
        let lp = 0;
        if (match) {
          lp = Number(match.lastPrice || match.last_price || match.ltp || match.lp || 0);
        }

        if (!lp || isNaN(lp)) {
          const cached = quotesCache.get(sym);
          if (cached && (Date.now() - cached.timestamp < 15000)) {
            return cached.data;
          }
          const fallbackItem = generateMockQuoteItem(sym);
          quotesCache.set(sym, { timestamp: Date.now(), data: fallbackItem });
          return fallbackItem;
        }

        const basePrice = getStockBasePrice(sym);
        const ohlc = match.ohlc || {};
        let prevClosePrice = Number(ohlc.close || basePrice);
        let ch = (match.net_change !== undefined && match.net_change !== 0) ? Number(match.net_change) : (lp - prevClosePrice);

        if (ch === 0 && ohlc.open) {
          ch = lp - Number(ohlc.open);
          prevClosePrice = Number(ohlc.open);
        }

        const chp = prevClosePrice > 0 ? (ch / prevClosePrice) * 100 : 0;

        const resItem = {
          n: sym,
          s: "ok",
          v: {
            lp: Number(lp.toFixed(2)),
            ch: Number(ch.toFixed(2)),
            chp: Number(chp.toFixed(2)),
            vol: Number(match.volume || Math.floor(500000 + Math.random() * 1000000)),
            oi: Number(match.oi || (sym.includes('INDEX') ? 0 : Math.floor(10000 + Math.random() * 50000))),
            oic: 0,
            avg_price: Number(match.average_price || lp),
            high: Number(ohlc.high || (lp * 1.005).toFixed(2)),
            low: Number(ohlc.low || (lp * 0.995).toFixed(2)),
            open: Number(ohlc.open || basePrice),
            prev_close: Number(ohlc.close || basePrice)
          }
        };

        quotesCache.set(sym, { timestamp: Date.now(), data: resItem });
        return resItem;
      });

    } catch (err: any) {
      if (err.response?.status === 429) {
        console.warn("[Quotes] 🚫 Rate limit hit (429). Backing off 15s...");
        rateLimitBackoffUntil = Date.now() + 15000;
      } else {
        console.error(`[Quotes] ❌ API Error (${err.response?.status}):`, err.response?.data?.message || err.message);
      }

      return requestedSymbols.map(sym => {
        const cached = quotesCache.get(sym);
        if (cached && (Date.now() - cached.timestamp < 30000)) {
          return cached.data;
        }
        return generateMockQuoteItem(sym);
      });
    }
  }

  // Proxy for market data
  app.get("/api/market/quotes", async (req, res) => {
    const { symbols } = req.query;

    if (!symbols) {
      return res.status(400).json({ error: "Missing symbols parameter" });
    }

    const symbolsStr = Array.isArray(symbols) ? symbols.join(",") : String(symbols);
    const requestedSymbols = symbolsStr.split(",").map(s => s.trim()).filter(Boolean);

    try {
      const data = await getDirectQuotes(requestedSymbols);
      return res.json({ s: "ok", d: data });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // OPTION CHAIN ENDPOINTS (live OI / IV / Greeks for stock options)
  app.get("/api/optionchain/expirylist", async (req, res) => {
    const underlying = String(req.query.underlying || "").toUpperCase().replace(/-EQ$/, "").replace(/\s+/g, "");
    const scrip = Number(dhanUnderlyingIdMap.get(underlying) || dhanScripMap.get(underlying));
    if (!scrip) return res.status(404).json({ success: false, message: `No underlying securityId for ${underlying}` });
    const list = await getDhanExpiryList(scrip, "NSE_EQ");
    res.json({ success: list.length > 0, underlying, expiries: list });
  });

  app.get("/api/optionchain", async (req, res) => {
    const underlying = String(req.query.underlying || "");
    const optionType = (String(req.query.type || "CE").toUpperCase() === "PE" ? "PE" : "CE") as "CE" | "PE";
    const offset = Number(req.query.offset || 0);
    const expiry = req.query.expiry ? String(req.query.expiry) : undefined;
    const leg = await resolveStockOptionLeg(underlying, optionType, offset, expiry);
    if (!leg) return res.status(404).json({ success: false, message: `Could not resolve ${optionType} leg for ${underlying} (needs live Dhan connection + scrip master).` });
    res.json({ success: true, leg });
  });

  // ORDER PLACEMENT ENDPOINT
  app.post("/api/trade/place", async (req, res) => {
    const { symbol, qty, type, side, price, paper, securityId, productType, underlying } = req.body;
    const orderType: "MARKET" | "LIMIT" = (type === "2" || !type) ? "MARKET" : "LIMIT";
    const txnSide: "BUY" | "SELL" = side === "SELL" ? "SELL" : "BUY";

    // PAPER MODE: explicit, clearly-labelled simulation. This is the ONLY place
    // a simulated fill is produced — it is never a silent fallback for a real failure.
    if (paper === true || process.env.PAPER_TRADING === "true") {
      console.log(`[Order] 📝 PAPER ${txnSide} ${qty} ${symbol}`);
      return res.json({
        success: true,
        paper: true,
        orderId: `PAPER_${Date.now().toString().slice(-8)}`,
        message: `📝 PAPER fill: ${txnSide} ${qty} ${symbol} @ ${orderType === "MARKET" ? "MKT" : price}`
      });
    }

    if (!process.env.DHAN_ACCESS_TOKEN) {
      return res.status(401).json({ success: false, message: "Dhan is not connected. Configure credentials or enable PAPER_TRADING." });
    }

    console.log(`[Order] LIVE ${txnSide} ${qty} ${symbol} (${orderType})...`);
    const result = await placeDhanOrder({
      symbol,
      securityId,
      side: txnSide,
      qty: Number(qty),
      orderType,
      price: Number(price || 0),
      productType,
      underlying
    });

    // Real outcome only. Failed/rejected orders return success:false.
    return res.status(result.success ? 200 : 422).json(result);
  });

  // TELEGRAM NOTIFICATIONS
  app.post("/api/notify/telegram", async (req, res) => {
    const { message } = req.body;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      console.error("[Telegram] Configuration missing");
      return res.status(400).json({
        error: "Telegram configuration missing",
        details: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not found"
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
      console.error("[Telegram] ❌ Failed to send message:", error.message);
      res.status(500).json({
        error: "Failed to send Telegram message",
        details: error.message
      });
    }
  });

  // BREAKOUT STRATEGY ENDPOINTS
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
      console.log(`[Breakout] Triggering scan for ${FNO_SYMBOLS.length} stocks...`);

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
        console.warn("[Breakout] Using simulated data");
        currentStocks = getLiveStockData();
      }

      await breakoutStrategyService.runBreakoutScan(currentStocks);
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

  // Background drift simulation
  setInterval(() => {
    if (breakoutStrategyService && breakoutStrategyService.isEnabled) {
      breakoutStrategyService.injectSimulatedMarketMove();
    }
  }, 3000);

  // Vite / Static Serving
  if (process.env.NODE_ENV !== "production") {
    console.log("[Server] Running in DEVELOPMENT mode");
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

  io.on("connection", (socket) => {
    console.log("[Socket] Client connected:", socket.id);

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

      if (niftyHistory.length > 5) {
        const niftyPlaceholder: StockData = { symbol: "NIFTY50", lastPrice: niftyHistory[niftyHistory.length - 1], vwap: niftyHistory[niftyHistory.length - 1] } as any;
        const vixPlaceholder: StockData = { symbol: "VIX", lastPrice: 15 } as any;

        const regime = MarketRegimeService.calculateRegime(
          niftyPlaceholder,
          vixPlaceholder,
          Math.max(1, advances),
          Math.max(1, declines),
          niftyHistory
        );
        currentRegime = regime;
        console.log(`[Scheduler] Regime: ${regime.regime}`);
        io.emit("market-regime-update", regime);
      }

      const marketStatus = isMarketOpen(now);

      const kolkataDateStr = now.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
      const istTime = now.toLocaleTimeString('en-US', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
      });
      const isWorkingDay = marketStatus.reason !== 'Weekend' && marketStatus.reason !== 'Market Holiday';

      // Scheduled Daily Automatic Dhan Login (08:50 AM IST)
      if (istTime === '08:50' && isWorkingDay && lastDhanAutoLoginDate !== kolkataDateStr) {
        lastDhanAutoLoginDate = kolkataDateStr;
        console.log(`[Scheduler] Running scheduled daily Dhan login...`);
        io.emit("bot-log", `SYSTEM: 08:50 AM IST scheduled login running...`);
        attemptDhanAutoLoginFromEnv().catch(e => console.error("[Scheduler] Daily login failed:", e));
      }

      // Scheduled Daily Breakout Scan (10:00 AM IST)
      if (istTime === '10:00' && isWorkingDay && lastBreakoutScanDate !== kolkataDateStr) {
        if (breakoutStrategyService && breakoutStrategyService.isEnabled) {
          lastBreakoutScanDate = kolkataDateStr;
          console.log(`[Scheduler] Running scheduled morning breakout scan...`);
          io.emit("bot-log", `SYSTEM: 10:00 AM IST scheduled scan running...`);

          try {
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
              currentStocks = getLiveStockData();
            }

            await breakoutStrategyService.runBreakoutScan(currentStocks);
            io.emit("bot-log", `SYSTEM: Scan completed! ${breakoutStrategyService.targets.length} targets identified.`);
          } catch (err: any) {
            console.error("[Scheduler] Breakout scan failed:", err.message);
          }
        }
      }

      if (marketStatus.open) {
        if (scannerService && !scannerService.isRunning) {
          console.log(`[Scheduler] Market OPEN. Starting scanner...`);
          scannerService.start().catch(e => console.error("[Scanner] Start failed:", e));
          io.emit("bot-log", `SYSTEM: Scanner resumed (Market open)`);
        }
      } else {
        if (scannerService && scannerService.isRunning) {
          console.log(`[Scheduler] Market CLOSED (${marketStatus.reason}). Stopping scanner...`);
          scannerService.stop();
        }
      }
    } catch (e: any) {
      console.error("[Scheduler] Error:", e.message);
    }
  }, 60000);

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 [Server] Trading Engine running on http://0.0.0.0:${PORT}`);
    console.log(`[Dhan] Connected: ${isDhanConnected ? "✅ YES" : "⏸️  NO (Simulation Mode)"}`);
    console.log("━".repeat(70) + "\n");
  });
}

startServer().catch(err => {
  console.error("❌ [CRITICAL] Server failed to start:", err);
});
