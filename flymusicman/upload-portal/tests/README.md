# Server tests

Node-only tests that run `Code.gs` against in-memory fakes of the Google
services (Drive, Sheets, properties, cache, mail, upload links) with a
controllable clock. Nothing here touches a real Google account, and these files
are not part of the Apps Script project.

```bash
node flymusicman/upload-portal/tests/sec.test.js
node flymusicman/upload-portal/tests/quota.test.js
```

- `sec.test.js`: which functions the public web app can call, setup and
  pause behavior, and finish tokens.
- `quota.test.js`: admission limits and how reserved space is held, settled
  and handed back.
