# BOE Records Management System

Route and track letters and memos across the Bureau of Equipment (DPWH), from the Office of the Director down to the sections.

- **The screen** lives here on GitHub Pages (`index.html`). It installs as an app on computers and phones.
- **The data** lives in your Google Sheet. `Code.gs` runs inside that sheet (Apps Script) and answers the screen.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole screen (grey Simple view) |
| `config.js` | The one setting: your Apps Script `/exec` link |
| `Code.gs` | The server. Paste it into Apps Script (kept here as a backup copy) |
| `manifest.webmanifest`, `sw.js` | Make it installable as an app |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `favicon.png` | App icons |

## Set up (once)

### A. Google Sheet + server
1. Make a new blank Google Sheet. Name it, for example, **BOE Records**.
2. **Extensions ▸ Apps Script.** Delete everything in `Code.gs`, paste the whole `Code.gs` from this repo, and click **Save**.
3. In the function list at the top, pick **setupSystem**, click **Run**, and allow the permissions.
   - It makes the sheets, the 13 BOE offices, one account per office, and a Drive folder for scans.
   - **View ▸ Execution log** shows the accounts and passwords.
4. **Deploy ▸ New deployment ▸ ⚙ ▸ Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, then copy the **Web app URL** (it ends in `/exec`).

### B. GitHub
5. Upload all these files to the repository's main page (**Add file ▸ Upload files**). Do not upload the zip itself, and don't put the files in a folder.
6. Open `config.js` ▸ ✏️ edit ▸ paste your `/exec` link between the quotes ▸ **Commit changes**.
7. **Settings ▸ Pages ▸ Source: Deploy from a branch ▸ Branch: main, / (root) ▸ Save.** After 1–2 minutes your link appears there: `https://<your-username>.github.io/<repo-name>/`.

### C. Use it
8. Open the link and sign in. The office accounts are **username = office code in small letters** and **password = code + @boe** (for example `od` / `od@boe`). The `admin` account is the system admin.
9. Change each password after the first sign-in (click your office name at the top right ▸ Change password).
10. To install it as an app: on a computer, click **Install app** at the top (Chrome or Edge). On Android, use the browser menu ▸ Install app. On an iPhone, open it in Safari ▸ Share ▸ Add to Home Screen.

## Updating later
- **Screen changes** (`index.html` and the other files): upload the new file to GitHub. Live in 1–2 minutes.
- **Server changes** (`Code.gs`): paste the new code in Apps Script, then **Deploy ▸ Manage deployments ▸ ✏️ Edit ▸ Version: New version ▸ Deploy**. The `/exec` link stays the same, so `config.js` doesn't change.

## Settings (in the Google Sheet, tab "Settings")
- `LOG_OFFICES`: offices that log new records and give tracking numbers (default `OD,ADMIN`; `ALL` lets every office log).
- `SEE_ALL_OFFICES`: offices that can open every record (default `OD,OAD,ADMIN`).
- `START_NUMBER`: lowest tracking number to give (raise it to continue a paper logbook).
- `AUTO_FIND_SCANS`: attaches a scan when a file in the scans folder starts with the tracking number, e.g. `25 - Letter.pdf`.
- `POLL_SECONDS`: how often each screen checks for new documents.
- Offices and units: sign in as `admin` ▸ **Admin ▸ Offices**. Add a unit with Level **Unit** and its section as the parent.

## Good to know
- Nobody can see your data from GitHub. The repo holds only the screen; your records stay in your Google Sheet, behind the sign-in.
- Every action waits 5 seconds (Undo) before it saves. If many offices save at once, it takes turns and retries by itself.
