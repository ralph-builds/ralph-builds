# Very Simple Video Uploads

A FLYfx web app: fans send videos straight from their phone into the owner's
Google Drive. No sign in. No account. No hassle. Runs on Google Apps Script;
live at flyfx.net/upload.

## What's here

- [upload-portal/](upload-portal/): the Apps Script project
  - `Code.gs`: server side (settings at the top in `CONFIG`)
  - `Page.html`: the page fans see
  - `appsscript.json`: permissions and web app settings
  - `SETUP.md`: setup, deployment and limits
  - `INTERNAL-UPLOAD-POLICY.md`: internal intake policy (Ralph and Jarvis)
  - `tests/`: Node tests that run `Code.gs` against fakes of the Google
    services; they never touch a real Google account
- [site/](site/): the flyfx.net files (`index.html` and `og-image.jpg` for
  /upload, `redirect/index.html` for the old address)
- [marketing/](marketing/): story poster and QR card

## Review: changes since the live version (v17)

1. **v18, security:** pause and resume are no longer public functions (Script
   property `PAUSED` instead), `setup` only works before first setup, and
   finishing a send needs a server-issued token and runs once.
2. **v19, quota:** send-count limits per hour and day, a per-send size cap and
   pending-versus-completed accounting. Reserved space is handed back only after
   Drive confirms an upload link is closed.
3. **Docs:** internal upload intake policy (no behavior change).

Run the tests:

```bash
node flymusicman/upload-portal/tests/sec.test.js
node flymusicman/upload-portal/tests/quota.test.js
```
