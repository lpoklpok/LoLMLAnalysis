"""
refresh_oe_mirror.py
Copies Tim Sevenhuysen's 2026 Oracle's Elixir CSV into a Drive folder you
own, deleting any stale copies first. Run via the daily workflow before
PullOEData; PullOEData then picks up the freshly-copied file via
OE_DRIVE_FOLDER_ID.

Required env:
  GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET
  GOOGLE_OAUTH_REFRESH_TOKEN  (get all 3 via: python src/oauth_setup.py <client_secret.json>)
  OE_DRIVE_FOLDER_ID          (destination folder in your Drive)

Optional:
  OE_SOURCE_FILE_ID           (override source file; default = Tim's 2026 CSV)
"""
import os
import re
import sys
from datetime import datetime, timezone

from google.oauth2.credentials import Credentials as OAuthCredentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SOURCE_FILE_ID    = os.environ.get("OE_SOURCE_FILE_ID") or "1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm"
DEST_FOLDER_ID    = os.environ["OE_DRIVE_FOLDER_ID"]

CURRENT_YEAR      = 2026


def _build_drive_client():
    try:
        creds = OAuthCredentials(
            token=None,
            refresh_token=os.environ["GOOGLE_OAUTH_REFRESH_TOKEN"],
            token_uri="https://oauth2.googleapis.com/token",
            client_id=os.environ["GOOGLE_OAUTH_CLIENT_ID"],
            client_secret=os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
            scopes=["https://www.googleapis.com/auth/drive"],
        )
    except KeyError as e:
        print(f"ERROR: missing env var {e}")
        sys.exit(1)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


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

    # Share the copy "anyone with link → reader" so the API-key downloader
    # in PullOEData can fetch it. Without this, the copy is private and
    # GOOGLE_API_KEY gets 403.
    try:
        drive.permissions().create(
            fileId=copy["id"],
            body={"role": "reader", "type": "anyone"},
            fields="id",
        ).execute()
        print(f"  set sharing: anyone-with-link reader")
    except HttpError as e:
        print(f"  WARNING: could not set sharing on copy: {e}")

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
