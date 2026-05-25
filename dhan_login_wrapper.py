import sys
import json
import os

def main():
    if len(sys.argv) < 7:
        print(json.dumps({
            "success": False, 
            "error": "Missing parameters. Required style: mobile_no, client_id, apikey, apisecret, totp_key, user_pin"
        }))
        return

    mobile_no = sys.argv[1]
    client_id = sys.argv[2]
    apikey = sys.argv[3]
    apisecret = sys.argv[4]
    totp_key = sys.argv[5]
    user_pin = sys.argv[6]

    # Add current directory to path
    sys.path.append(os.path.abspath(os.path.dirname(__file__)))

    try:
        # Try direct import first (bypassing sourcedefender and .pye restrictions)
        try:
            from dhan_token_automate import GetAccessToken
        except ImportError as direct_ie:
            print(f"Direct import of dhan_token_automate failed, trying with sourcedefender: {direct_ie}", file=sys.stderr)
            import sourcedefender
            from dhan_token_automate import GetAccessToken
        
        print("Executing token generation via dhan_token_automate...", file=sys.stderr)
        
        access_token = GetAccessToken(mobile_no, client_id, apikey, apisecret, totp_key, user_pin)
        
        if access_token:
            print(json.dumps({
                "success": True,
                "token": access_token
            }))
        else:
            print(json.dumps({
                "success": False,
                "error": "GetAccessToken returned an empty or invalid token. Please check your login credentials and TOTP Key."
            }))
            
    except ImportError as ie:
        print(f"Import Error details: {str(ie)}", file=sys.stderr)
        errorMessage = str(ie)
        if "sourcedefender" in errorMessage:
            msg = "Missing 'sourcedefender' module. Please ensure 'sourcedefender' is installed in your Python environment."
        elif "dhan_token_automate" in errorMessage:
            msg = "Missing 'dhan_token_automate.pye' file in the root directory. Please upload this file to execute the automatic login."
        else:
            msg = f"Missing python dependency: {errorMessage}. Please install pycryptodome, pyotp, and requests."
            
        print(json.dumps({
            "success": False,
            "error": msg,
            "type": "import_error"
        }))
    except Exception as e:
        print(f"Routine Execution Error: {str(e)}", file=sys.stderr)
        print(json.dumps({
            "success": False,
            "error": f"Automation script failed: {str(e)}"
        }))

if __name__ == "__main__":
    main()
