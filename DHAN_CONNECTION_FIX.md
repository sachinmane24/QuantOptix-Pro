# 🚀 Dhan Connection Fix Guide

This guide explains all the improvements made to fix Dhan App connectivity and real data streaming.

## 📋 What Was Fixed

### 1. **Enhanced Scrip Master Loading** ✅
- **Problem**: CSV download could fail silently
- **Fix**: Added retry logic, better error handling, expanded fallback symbols list
- **Result**: App works even if CDN is temporarily unavailable

### 2. **Token Validation & Refresh** ✅
- **Problem**: Invalid tokens weren't caught until trade execution
- **Fix**: Added explicit token validation on startup and before API calls
- **Result**: Errors caught immediately with clear diagnostic messages

### 3. **Quote Fetching Diagnostics** ✅
- **Problem**: Silent fallback to mock data made debugging impossible
- **Fix**: Added detailed logging at each step with timestamps
- **Result**: Can now see exactly what's happening: API calls, responses, cache hits

### 4. **Startup Configuration Validation** ✅
- **Problem**: Server started without confirming Dhan was configured
- **Fix**: Added comprehensive startup check before initializing services
- **Result**: Clear error messages if credentials are missing

### 5. **Improved Error Messages** ✅
- **Problem**: Generic error responses
- **Fix**: Specific error codes, HTTP status codes, structured logs
- **Result**: Much easier to debug API issues

---

## 🔧 Setup Instructions

### **Option A: Quick Start with Manual Token (5 minutes)**

1. **Get your token from Dhan:**
   ```
   1. Open https://dhanhq.co
   2. Login with your Dhan account
   3. Go to Settings → API Keys
   4. Click "Generate Token"
   5. Copy the token (valid 30 days)
   ```

2. **Create `.env` file:**
   ```bash
   DHAN_ACCESS_TOKEN=your_token_here
   DHAN_CLIENT_ID=your_client_id_here
   ```

3. **Run the app:**
   ```bash
   npm run dev
   ```

4. **Test the connection:**
   ```bash
   npx tsx test-dhan-connection.ts
   ```

### **Option B: Production Setup with Auto-Login (10 minutes)**

This method auto-generates a fresh token every day - no manual renewal needed!

#### Step 1: Get Client ID
```
1. Go to https://dhanhq.co/settings/api
2. Copy your "Client ID"
```

#### Step 2: Setup TOTP (2FA)
```
1. Go to https://dhanhq.co/settings/security
2. Click "Enable 2FA / TOTP"
3. Scan the QR code with Google Authenticator/Authy
4. Copy the "Base32 Secret Key" (NOT the QR code)
```

#### Step 3: Get Your PIN
```
Use your existing 4-digit Dhan trading PIN
```

#### Step 4: Create `.env`
```bash
DHAN_CLIENT_ID=your_client_id
DHAN_TOTP_KEY=your_base32_secret
DHAN_USER_PIN=1234
DHAN_MOBILE=your_phone_number_optional
```

#### Step 5: Test Auto-Login
```bash
npx tsx test-dhan-connection.ts
```

You should see:
```
✅ Token generated successfully!
✅ Connected to Dhan API!
```

---

## 🧪 Diagnostic Tool

Run this to test your Dhan connection:

```bash
npx tsx test-dhan-connection.ts
```

**This will:**
- ✅ Check environment variables
- ✅ Test token generation (if auto-login configured)
- ✅ Validate connection to Dhan API
- ✅ Fetch sample quote data
- ✅ Test CSV download

**Expected output:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 DHAN CONNECTION DIAGNOSTIC TOOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Environment Configuration Check:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DHAN_ACCESS_TOKEN: ✅ SET
DHAN_CLIENT_ID: ✅ SET
✅ Connected to Dhan API!
Available Margin: 250000
✅ Quote fetch successful!
✅ Scrip Master CSV available!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ DIAGNOSTIC TEST COMPLETE
```

---

## 📊 Logging & Debugging

The improved logs now show:

### **Startup Logs:**
```
[STARTUP] Dhan Configuration Check:
  Token Present: ✅ YES
  Auto-login Config: ✅ YES

[STARTUP] Attempting Dhan connection...
[Dhan] 🔄 Generating automated token for Client ID: ABC123
[Dhan] ✅ Automated login succeeded!
[Dhan] 🔍 Downloading scrip master from CDN...
[Dhan] ✅ Scrip Master loaded: 3500+ symbols registered
```

### **Quote Fetching Logs:**
```
[Quotes] 🔍 Fetching 13 symbols...
[Quotes] ✅ Response received. Status: success
[Quotes] Data cached for next 3 seconds
```

### **Error Logs:**
```
[Dhan] ❌ Token validation failed (401): Invalid token
[Dhan] 🔄 Token expired. Attempting refresh...
[Quotes] 🚫 Rate limit hit (429). Backing off 15s...
```

---

## 🔐 Security Notes

### **Token Management:**
- ✅ Tokens are cached locally in `dhan-credentials.json` (valid 12 hours)
- ✅ No secrets stored in logs
- ✅ Auto-refresh before expiry
- ❌ **Never commit `.env` or `dhan-credentials.json`** to Git

### **Environment Variables:**
Use your hosting platform's secrets manager:
- **Vercel**: Settings → Environment Variables
- **Heroku**: Settings → Config Vars
- **Docker**: Pass via `docker run -e DHAN_ACCESS_TOKEN=...`
- **PM2**: Use `.env` file (git-ignored)

---

## 🐛 Troubleshooting

### **"No valid Dhan credentials found"**
```
✓ Check DHAN_ACCESS_TOKEN is set correctly
✓ Or set DHAN_CLIENT_ID + DHAN_TOTP_KEY + DHAN_USER_PIN
✓ Restart the server after adding to .env
```

### **"Token validation failed (401)"**
```
✓ Your token has expired (valid 30 days)
✓ Generate a new token from https://dhanhq.co/settings/api
✓ Update DHAN_ACCESS_TOKEN in .env
```

### **"Rate limit hit (429)"**
```
✓ Normal - the app backs off automatically
✓ Try again in 15 seconds
✓ Check if you're calling API too frequently
```

### **"No securityId found for symbol: SYMBOL"**
```
✓ Symbol not in scrip master CSV
✓ App uses fallback mock data automatically
✓ Check symbol is correct (e.g., "RELIANCE" not "RELIANCE.EQ")
```

### **"Scrip Master download failed"**
```
✓ CDN might be temporarily down
✓ App uses fallback scrip list automatically
✓ You can trade with major symbols
✓ Will retry download in background
```

---

## 📈 Real Data vs Simulation Mode

### **Real Data (✅ Dhan Connected):**
- Live quotes from NSE
- Real market data with OHLC
- Actual trading possible
- Rate limits apply (~100 quotes/second)

### **Simulation Mode (⚠️ Dhan Not Connected):**
- Deterministic mock data
- Realistic price movements
- Good for testing strategies
- No API rate limits

**Check status:**
```
GET /api/health
GET /api/auth/dhan/status
```

---

## 🎯 Next Steps

1. ✅ **Copy `.env.example` to `.env`**
2. ✅ **Add your Dhan credentials**
3. ✅ **Run diagnostic tool**: `npx tsx test-dhan-connection.ts`
4. ✅ **Start server**: `npm run dev`
5. ✅ **Open browser**: http://localhost:3000
6. ✅ **Check logs** for `[Dhan] ✅` confirmation

---

## 📞 Support

If you still have issues:

1. **Check logs** - Most issues are clearly described
2. **Run diagnostic** - `npx tsx test-dhan-connection.ts`
3. **Check .env** - Make sure variables are set correctly
4. **Restart server** - Changes to `.env` need restart
5. **Check Dhan status** - Visit https://dhanhq.co

---

**Happy trading! 🚀**
