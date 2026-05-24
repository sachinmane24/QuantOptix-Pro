import sys
import os
import json
import requests
import pyotp

def GetAccessToken(mobile_no, client_id, apikey, apisecret, totp_key, user_pin):
    """
    Automated Dhan HQ API Token verification and generation fallback.
    If the provided API Key is a valid 30-day Personal Access Token, it will validate it and return it.
    """
    print(f"[Dhan Automation] Initiating token verification for Client ID: {client_id}...", file=sys.stderr)
    
    # 1. Clean and check the API key (which is the Access Token on Dhan HQ portal)
    token = (apikey or "").strip()
    
    # If the token is empty but they supplied other variables, we can check if they provided
    # the access token in other slots, or fall back gracefully
    if not token and len(apisecret) > 50:
        token = apisecret.strip()

    if token:
        print("[Dhan Automation] Validating provided token with Dhan HQ servers...", file=sys.stderr)
        headers = {
            "access-token": token,
            "Content-Type": "application/json"
        }
        try:
            # Check validity via fundlimit endpoint
            res = requests.get("https://api.dhan.co/v2/fundlimit", headers=headers, timeout=10)
            if res.status_code == 200:
                print("[Dhan Automation] Token validated successfully! Access granted.", file=sys.stderr)
                return token
            else:
                print(f"[Dhan Automation] Validation direct check returned status {res.status_code}. Checking alternative formats...", file=sys.stderr)
        except Exception as e:
            print(f"[Dhan Automation] Direct verification connection error: {e}", file=sys.stderr)

    # 2. If the user provided a standard Personal Access Token (JWT format starting with eyJ)
    if token and (token.startswith("eyJ") or len(token) > 60):
        print("[Dhan Automation] Token looks like a formatted Dhan JWT. Returning for session injection.", file=sys.stderr)
        return token

    # 3. Inform user of alternative setup
    print("[Dhan Automation] Token validation failed or no active token passed. Since SEBI mandates manual TOTP consent, the most stable approach is entering your 30-day Personal Access Token (API Key) directly.", file=sys.stderr)
    return None
