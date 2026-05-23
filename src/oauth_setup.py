"""
oauth_setup.py — one-time local script to get a Google Drive OAuth refresh
token for your personal Google account.

Why this exists: service accounts can't own files in a personal "My Drive"
folder (no storage quota — they only work in Shared Drives, which require
Workspace). So instead of an SA, we have GH Actions act as YOU via an OAuth
refresh token. You own the copied files, your quota applies, the mirror
works.

Run this once locally. It opens a browser, you click "Allow", it prints
three values to set as GitHub secrets:
  GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET
  GOOGLE_OAUTH_REFRESH_TOKEN

Prereqs:
  1. In https://console.cloud.google.com/apis/credentials, create an
     OAuth 2.0 Client ID of type "Desktop app". Download the client_secret JSON.
  2. Pass its path as the first arg:  python src/oauth_setup.py path/to/client_secret.json

  pip install google-auth-oauthlib
"""
import json
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive"]


def main():
    if len(sys.argv) != 2:
        print("usage: python src/oauth_setup.py <path-to-client_secret.json>")
        sys.exit(1)
    secret_path = Path(sys.argv[1])
    if not secret_path.is_file():
        print(f"ERROR: {secret_path} not found")
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(str(secret_path), SCOPES)
    # run_local_server spins up a temporary http server, opens browser, captures
    # the redirect with the auth code, and exchanges for tokens.
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")

    with secret_path.open() as f:
        client = json.load(f)
    web = client.get("installed") or client.get("web") or {}
    client_id = web.get("client_id", "")
    client_secret = web.get("client_secret", "")

    print()
    print("=" * 72)
    print("SUCCESS — set these three values as GitHub Actions secrets:")
    print("=" * 72)
    print(f"GOOGLE_OAUTH_CLIENT_ID       = {client_id}")
    print(f"GOOGLE_OAUTH_CLIENT_SECRET   = {client_secret}")
    print(f"GOOGLE_OAUTH_REFRESH_TOKEN   = {creds.refresh_token}")
    print("=" * 72)
    print()
    print("Set them with gh CLI:")
    print(f"  gh secret set GOOGLE_OAUTH_CLIENT_ID     --body '{client_id}'")
    print(f"  gh secret set GOOGLE_OAUTH_CLIENT_SECRET --body '{client_secret}'")
    print(f"  gh secret set GOOGLE_OAUTH_REFRESH_TOKEN --body '{creds.refresh_token}'")


if __name__ == "__main__":
    main()
