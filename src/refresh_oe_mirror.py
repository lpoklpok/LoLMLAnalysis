"""
refresh_oe_mirror.py
Copies Tim Sevenhuysen's 2026 Oracle's Elixir CSV into a Drive folder you
own, deleting any stale copies first. Run via the daily workflow before
PullOEData; PullOEData then picks up the freshly-copied file via
OE_DRIVE_FOLDER_ID.

Auth modes (one or the other):

  OAuth user delegation (preferred — works on personal Gmail):
    GOOGLE_OAUTH_CLIENT_ID
    GOOGLE_OAUTH_CLIENT_SECRET
    GOOGLE_OAUTH_REFRESH_TOKEN
    Get these via: python src/oauth_setup.py <client_secret.json>

  Service account (only works for Shared Drives — Workspace only):
    GOOGLE_SA_JSON

Always required:
  OE_DRIVE_FOLDER_ID   — destination folder in your Drive

Optional:
  OE_SOURCE_FILE_ID    — override source file (default = Tim's 2026 CSV)
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

from google.oauth2 import service_account
from google.oauth2.credentials import Credentials as OAuthCredentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SOURCE_FILE_ID    = os.environ.get("OE_SOURCE_FILE_ID") or "1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm"
DEST_FOLDER_ID    = os.environ["OE_DRIVE_FOLDER_ID"]

CURRENT_YEAR      = 2026


def _build_drive_client():
    oauth_rt = os.environ.get("GOOGLE_OAUTH_REFRESH_TOKEN")
    oauth_cid = os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
    oauth_cs = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")
    if oauth_rt and oauth_cid and oauth_cs:
        print("auth: using OAuth user delegation")
        creds = OAuthCredentials(
            token=None,
            refresh_token=oauth_rt,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=oauth_cid,
            client_secret=oauth_cs,
            scopes=["https://www.googleapis.com/auth/drive"],
        )
        return build("drive", "v3", credentials=creds, cache_discovery=False)

    sa_json = os.environ.get("GOOGLE_SA_JSON")
    if sa_json:
        print("auth: using service account (only works for Shared Drives)")
        info = json.loads(sa_json)
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/drive"],
        )
        return build("drive", "v3", credentials=creds, cache_discovery=False)

    print("ERROR: no auth configured — set GOOGLE_OAUTH_* (preferred) or GOOGLE_SA_JSON")
    sys.exit(1)


def main():
    drive = _build_drive_client()

    q = f"'{DEST_FOLDER_ID}' in parents and trashed = false"
    existing = drive.files().list(q=q, fields="files(id,name,modifiedTime,size,mimeType)").execute().get("files", [])
    print(f"folder currently has {len(existing)} file(s)")
    for f in existing:
        print(f"  - {f['name']}  (id={f['id']}, modified={f['modifiedTime']}, size={f.get('size','?')}, mime={f.get('mimeType','?')})")

    try:
        src = drive.files().get(fileId=SOURCE_FILE_ID, fields="id,name,modifiedTime,size").execute()
    except HttpError as e:
        print(f"ERROR: can't read source file {SOURCE_FILE_ID}: {e}")
        sys.exit(1)
    print(f"source: '{src['name']}'  modified={src['modifiedTime']}  size={src.get('size','?')}")

    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    new_name = f"{CURRENT_YEAR}_LoL_OE_{ts}.csv"
    try:
        copy = drive.files().copy(
            fileId=SOURCE_FILE_ID,
            body={"name": new_name, "parents": [DEST_FOLDER_ID]},
            fields="id,name,modifiedTime,size",
        ).execute()
    except HttpError as e:
        print(f"ERROR: copy failed: {e}")
        sys.exit(1)
    print(f"copied → '{copy['name']}'  id={copy['id']}  size={copy.get('size','?')}")

    # Trash older files — ONLY those that match our own mirror naming pattern
    # `{YEAR}_LoL_OE_*.csv`. Manually-uploaded user files with different names
    # are preserved so a known-good copy isn't clobbered if upstream rolls back.
    mirror_pat = re.compile(rf"^{CURRENT_YEAR}_LoL_OE_\d+T\d+Z\.csv$")
    for f in existing:
        if not mirror_pat.match(f["name"] or ""):
            print(f"  kept (user-uploaded): {f['name']}")
            continue
        try:
            drive.files().delete(fileId=f["id"]).execute()
            print(f"  deleted prior mirror: {f['name']}")
        except HttpError as e:
            print(f"  could not delete {f['name']}: {e}")


if __name__ == "__main__":
    main()
