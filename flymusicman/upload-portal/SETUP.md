# Fly Music Man footage drop: setup

A web page where anyone can send videos from their phone straight into your
Google Drive. They agree to a footage release, can leave a name for credits,
and can leave an email to be eligible for future prize giveaways. Every
submission is logged in a Google Sheet.

It runs free on Google Apps Script in your own Google account. Uploaders don't
need a Google account.

## What's in this folder

| File | What it is |
|---|---|
| `Code.gs` | The server side. Settings are at the top (`CONFIG`). |
| `Page.html` | The upload page people see. |
| `appsscript.json` | Permissions and web app settings. |

## One-time setup (about 10 minutes)

1. Go to <https://script.google.com> while signed in to the Google account that
   should own the footage. Click **New project**.
2. Click **Untitled project** at the top and rename it `Fly Music Man Uploads`.
3. Click the **gear icon (Project Settings)** on the left. Tick **Show
   "appsscript.json" manifest file in editor**. While you're there, set the
   **Time zone** to yours.
4. Click the **< > (Editor)** icon on the left. You'll see `Code.gs` and
   `appsscript.json`.
   - Open `appsscript.json`, delete everything, paste in this folder's
     `appsscript.json`. If you changed the time zone in step 3, keep that
     `"timeZone"` line instead of the pasted one.
   - Open `Code.gs`, delete everything, paste in this folder's `Code.gs`.
   - Click **+** next to Files, choose **HTML**, name it `Page` (it adds
     `.html` itself), delete what's there, paste in this folder's `Page.html`.
   - Press **Ctrl+S / Cmd+S** to save.
5. In the toolbar's function dropdown, pick **setup**, then click **Run**.
   - Google asks you to authorize. Pick your account.
   - You'll see **"Google hasn't verified this app."** That's normal for a
     script you wrote yourself. Click **Advanced**, then **Go to Fly Music Man
     Uploads (unsafe)**, then **Allow**.
   - The log at the bottom shows links to the new **Fly Music Man Uploads**
     folder and the **Fly Music Man Submissions** sheet in your Drive.
6. Click **Deploy > New deployment**. Click the gear next to "Select type" and
   pick **Web app**.
   - Description: `v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, then copy the **Web app URL**. That's the page to share.

## What the permissions mean

The script asks for:

- **"See, edit, create and delete only the specific Google Drive files you use
  with this app."** It can only see the folder, sheet and videos it created.
  The rest of your Drive is invisible to it.
- **"Connect to an external service."** Used to send the video data to Drive.
- **"Send email as you."** Your notification and the contributor thank-you.
- **"See your primary email address."** So notifications go to you.

You can remove its access any time at <https://myaccount.google.com/permissions>.

## Test it before sharing

From your iPhone, open the Web app URL and:

1. Send a short clip with a name and email. Check that:
   - the video appears in a new subfolder of **Fly Music Man Uploads**,
   - a row appears in the **Submissions** tab of the sheet with Status
     **Complete**,
   - you get a notification email, and the contributor email gets a thank-you.
2. Send a long clip (1 GB or more) to check big files.
3. Compare the file size in Drive with the size on the phone. If Drive's copy is
   much smaller, the iPhone shrank it while picking. Choosing the video through
   **Browse / Files** instead of the photo library usually sends the original.
4. Look at the **Upload method** column. `direct` means videos went straight
   from the phone to Drive (fastest). `relay` means they went through the
   script, which works but is slower. Tell Claude which one you see.

## Changing things later

- **Wording, limits, emails:** edit `CONFIG` at the top of `Code.gs`.
- **Release wording:** edit `RELEASE_TEXT` **and** change `RELEASE_VERSION`
  (for example to `2026-11-15-v2`). The sheet keeps every version in the
  **Release versions** tab, and each submission records which one the person
  agreed to.
- **Pause uploads:** set `ACCEPTING_UPLOADS: false`.
- **Colors:** the `:root` block at the top of `Page.html`.

After any change, publish it to the same URL: **Deploy > Manage deployments >**
pencil icon **> Version: New version > Deploy**. (A "New deployment" would make
a new URL.)

## Limits to know about

- Up to 10 videos per submission, 5 GB each, 200 GB a day in total
  (all adjustable in `CONFIG`). Drive's own cap is 750 GB uploaded per day.
- Personal Google accounts can send about 100 emails a day. If you get more
  submissions than that, turn off `SEND_THANK_YOU` or `NOTIFY_OWNER`.
  Submissions still work and are still logged when email runs out.
- Google shows a small "This application was created by a Google Apps Script
  user" bar on the page. Embedding the page on your own site (for example
  flyfx.net/flymusicman) hides it and gives a nicer address.

## Before going public

- **Release wording:** the text in `CONFIG.RELEASE_TEXT` is a draft. Have a
  lawyer check it, and set `RIGHTS_HOLDER` to the legal name (person or
  business) that should own the footage.
- **Prize giveaways:** the page only promises eligibility for future
  giveaways. Before running an actual drawing, post official rules (who can
  enter, dates, prize, how the winner is picked, "no purchase necessary" with a
  free way to enter).
