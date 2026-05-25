import sys
import json

try:
    import requests
    import pyotp
except ImportError as e:
    print(json.dumps({"success": False, "error": f"Missing python package: {e}. Please ensure requests and pyotp are installed.", "type": "AUTH_FAIL"}))
    sys.exit(1)

def GetAccessToken(client_id, user_pin, totp_key):
    """
    Automated Dhan HQ API Token generation using Dhan V2 endpoints.
    """
    try:
        totp = pyotp.TOTP(totp_key).now()
    except Exception as e:
        return {"success": False, "error": f"TOTP generation failed: {e}", "type": "AUTH_FAIL"}

    url = f"https://auth.dhan.co/app/generateAccessToken?dhanClientId={client_id}&pin={user_pin}&totp={totp}"
    
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json"
    }

    try:
        response = requests.post(url, headers=headers, timeout=15)
        if response.status_code == 200:
            data = response.json()
            if "accessToken" in data:
                return {"success": True, "token": data["accessToken"]}
            else:
                return {"success": False, "error": f"API returned 200 but no accessToken in response. Data: {json.dumps(data)}", "type": "AUTH_FAIL"}
        else:
            return {"success": False, "error": f"Dhan API returned {response.status_code}: {response.text}", "type": "AUTH_FAIL"}
    except Exception as e:
        return {"success": False, "error": str(e), "type": "NETWORK_ERR"}

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(json.dumps({"success": False, "error": "Missing parameters."}))
        sys.exit(1)
        
    client_id = sys.argv[1]
    user_pin = sys.argv[2]
    totp_key = sys.argv[3]
    
    result = GetAccessToken(client_id, user_pin, totp_key)
    print(json.dumps(result))
