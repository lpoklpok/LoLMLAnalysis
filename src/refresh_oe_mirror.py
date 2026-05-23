"""
refresh_oe_mirror.py
Copies Tim Sevenhuysen's 2026 Oracle's Elixir CSV into a Drive folder you
own, deleting any stale copies first. Run via the daily workflow before
PullOEData; PullOEData then picks up the freshly-copied file via
OE_DRIVE_FOLDER_ID.

Requires:
  GOOGLE_SA_JSON       — service-account JSON key (full contents)
  OE_DRIVE_FOLDER_ID   — destination folder in your Drive (shared with the
                         service-account email as Editor)
  Optional:
    OE_SOURCE_FILE_ID  — override source file (default = Tim's 2026 CSV)
"""
import json
import os
import sys
from datetime import datetime, timezone

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SOURCE_FILE_ID    = os.environ.get("OE_SOURCE_FILE_ID") or "1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm"
DEST_FOLDER_ID    = os.environ["OE_DRIVE_FOLDER_ID"]
SA_JSON           = os.environ["GOOGLE_SA_JSON"]

CURRENT_YEAR      = 2026


def main():
    info = json.loads(SA_JSON)
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/drive"],
    )
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)

    # 1. List existing CSVs in the destination folder
    q = f"'{DEST_FOLDER_ID}' in parents and trashed = false"
    existing = drive.files().list(q=q, fields="files(id,name,modifiedTime,size)").execute().get("files", [])
    print(f"folder currently has {len(existing)} file(s)")
    for f in existing:
        print(f"  - {f['name']}  (id={f['id']}, modified={f['modifiedTime']}, size={f.get('size','?')})")

    # 2. Look up source file metadata
    try:
        src = drive.files().get(fileId=SOURCE_FILE_ID, fields="id,name,modifiedTime,size").execute()
    except HttpError as e:
        print(f"ERROR: can't read source file {SOURCE_FILE_ID}: {e}")
        sys.exit(1)
    print(f"source: '{src['name']}'  modified={src['modifiedTime']}  size={src.get('size','?')}")

    # 3. Copy source into destination folder with a timestamped name so
    #    each refresh creates a new file (and we trash the old ones).
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

    # 4. Trash older files — ONLY those that match our own mirror naming pattern
    # `{YEAR}_LoL_OE_*.csv`. Manually-uploaded user files (with different names
    # like `2026_LoL_esports_match_data_from_OraclesElixir.csv`) are preserved
    # so the user's known-good copy isn't clobbered if Tim's source rolls back.
    import re
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
