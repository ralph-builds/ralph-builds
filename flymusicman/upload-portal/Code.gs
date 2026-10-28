/**
 * FlyMusicMan footage drop.
 *
 * A Google Apps Script web app where anyone can upload videos (iPhone-friendly,
 * large files OK) into a Google Drive folder, agree to a footage release, and
 * optionally leave a name for credits and an email for future prize giveaways.
 * Every submission is logged to a Google Sheet.
 *
 * The script can only see files it creates itself (the "drive.file" permission),
 * so it never touches anything else in the owner's Drive.
 *
 * Setup and deployment: see SETUP.md next to this file.
 */

// ---------------------------------------------------------------------------
// Settings. After editing, redeploy: Deploy > Manage deployments > pencil icon
// > Version: New version > Deploy. The page URL stays the same.
// ---------------------------------------------------------------------------
const CONFIG = {
  BRAND_NAME: 'FlyMusicMan',
  // The person or business that receives the rights. Use the legal name.
  RIGHTS_HOLDER: 'FlyMusicMan',
  YOUTUBE_URL: 'https://www.youtube.com/@FlyMusicMan',

  // Set to false to close the page to new uploads (it shows a "paused" note).
  // To pause without redeploying, run pauseUploads (and resumeUploads to reopen).
  ACCEPTING_UPLOADS: true,
  MAX_FILES_PER_SUBMISSION: 10,
  MAX_FILE_GB: 5,
  // Total accepted per day across everyone. Google Drive's own cap is 750 GB/day.
  DAILY_LIMIT_GB: 200,
  // Total accepted in any 60 minutes, so one burst can't use up the whole day.
  HOURLY_LIMIT_GB: 50,
  // What people see when a cap is hit. You also get an email.
  DAILY_LIMIT_MESSAGE: 'We’re oversaturated for tonight! So many people sent footage. Please try again tomorrow.',
  HOURLY_LIMIT_MESSAGE: 'We’re oversaturated right now! So many people are sending footage. Please try again in an hour.',

  // Email the owner about each submission. Blank NOTIFY_EMAIL means the account
  // that ran setup(). Personal Google accounts can send about 100 emails a day.
  NOTIFY_OWNER: true,
  NOTIFY_EMAIL: '',
  // Send a short thank-you to contributors who left an email.
  SEND_THANK_YOU: true,

  FOLDER_NAME: 'FlyMusicMan Uploads',
  SHEET_NAME: 'FlyMusicMan Submissions',

  // Change RELEASE_VERSION whenever you change the wording below, so the Sheet
  // records exactly which wording each person agreed to.
  RELEASE_VERSION: '2026-10-28-v1',
  RELEASE_TEXT: [
    'I recorded the video(s) I’m uploading, or I otherwise own all rights to them, and they don’t infringe anyone else’s rights. Anyone who can be recognized in the footage agreed to be filmed and to have the footage used as described here.',
    'I transfer to {RIGHTS_HOLDER} all of my rights, title and interest in the footage, including copyright. Where a right can’t be transferred, I give {RIGHTS_HOLDER} an exclusive, permanent, worldwide, royalty-free license to it, and I waive any moral rights. {RIGHTS_HOLDER}, and anyone {RIGHTS_HOLDER} authorizes, may use, edit, copy, combine, publish and sell the footage, in whole or in part, in any media now known or invented later, for any purpose, including commercial use.',
    'I won’t be paid for the footage or for any use of it. {RIGHTS_HOLDER} doesn’t have to use it. Credit is up to {RIGHTS_HOLDER}; leaving my name doesn’t guarantee credit.',
    'I release {RIGHTS_HOLDER} from any claims related to the use of the footage, including claims about privacy or the use of my name, voice or likeness as they appear in it. This agreement is permanent and can’t be revoked.',
  ],
  PRIZE_TEXT: 'Leave your email to be eligible for future {BRAND_NAME} prize giveaways. Any giveaway will have its own official rules, posted before it starts. We’ll only use your email for giveaways and about your footage, and we won’t sell or share it.',
};

// ---------------------------------------------------------------------------
// Internals. No need to edit below here.
// ---------------------------------------------------------------------------
const SUBMISSIONS_TAB = 'Submissions';
const RELEASES_TAB = 'Release versions';
const SUBMISSION_HEADERS = [
  'Started', 'Submission ID', 'Status', 'Credit name', 'Email', 'Prize opt-in',
  'Notes', 'Files sent', 'Files received', 'Size (MB)', 'Folder', 'File names',
  'Release version', 'Agreed to release', 'Confirmed 18+', 'Device', 'Completed',
  'Upload method',
];
const COL = SUBMISSION_HEADERS.reduce((map, name, i) => (map[name] = i, map), {});

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id';
// Resumable upload chunks must be multiples of 256 KiB.
const DIRECT_CHUNK_BYTES = 8 * 1024 * 1024;
const RELAY_CHUNK_BYTES = 4 * 1024 * 1024;
const CACHE_SECONDS = 6 * 60 * 60;
const GB = 1024 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The page runs in an iframe on a *.googleusercontent.com origin.
const ALLOWED_ORIGIN_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.googleusercontent\.com$/;
const VIDEO_TYPES = {
  mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', hevc: 'video/hevc',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska', webm: 'video/webm', '3gp': 'video/3gpp',
  mts: 'video/mp2t', m2ts: 'video/mp2t',
};

/**
 * Run once from the editor. Creates the uploads folder and the log Sheet
 * (inside that folder), and is safe to run again to repair a missing piece.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();

  let folderId = props.getProperty('FOLDER_ID');
  if (!folderId || !isUsable_(folderId)) {
    folderId = Drive.Files.create({ name: CONFIG.FOLDER_NAME, mimeType: FOLDER_MIME }).id;
    props.setProperty('FOLDER_ID', folderId);
  }

  let sheetId = props.getProperty('SHEET_ID');
  if (!sheetId || !isUsable_(sheetId)) {
    sheetId = Drive.Files.create({ name: CONFIG.SHEET_NAME, mimeType: SHEET_MIME, parents: [folderId] }).id;
    const firstTab = Sheets.Spreadsheets.get(sheetId, { fields: 'sheets.properties.sheetId' }).sheets[0];
    Sheets.Spreadsheets.batchUpdate({
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: firstTab.properties.sheetId, title: SUBMISSIONS_TAB, gridProperties: { frozenRowCount: 1 } },
            fields: 'title,gridProperties.frozenRowCount',
          },
        },
        { addSheet: { properties: { title: RELEASES_TAB, gridProperties: { frozenRowCount: 1 } } } },
      ],
    }, sheetId);
    writeRow_(sheetId, `${SUBMISSIONS_TAB}!A1`, SUBMISSION_HEADERS);
    writeRow_(sheetId, `'${RELEASES_TAB}'!A1`, ['Version', 'First used', 'Full release text']);
    props.setProperty('SHEET_ID', sheetId);
    props.deleteProperty('RELEASES_LOGGED');
  }

  try {
    props.setProperty('OWNER_EMAIL', Session.getEffectiveUser().getEmail());
  } catch (err) {
    console.warn('Could not read the owner email; set CONFIG.NOTIFY_EMAIL instead.', err);
  }
  ensureReleaseLogged_(sheetId);

  console.log(`Uploads folder: https://drive.google.com/drive/folders/${folderId}`);
  console.log(`Submissions sheet: https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  console.log('Setup complete. Next: Deploy > New deployment > Web app.');
}

function doGet() {
  const template = HtmlService.createTemplateFromFile('Page');
  // Escape "<" so the JSON can't close the <script> tag it sits in.
  template.appJson = JSON.stringify(publicConfig_()).replace(/</g, '\\u003c');
  return template.evaluate()
    .setTitle(`Send your footage to ${CONFIG.BRAND_NAME}`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function publicConfig_() {
  const ready = !!PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  return {
    brandName: CONFIG.BRAND_NAME,
    rightsHolder: CONFIG.RIGHTS_HOLDER,
    youtubeUrl: CONFIG.YOUTUBE_URL,
    accepting: isAccepting_() && ready,
    maxFiles: CONFIG.MAX_FILES_PER_SUBMISSION,
    maxFileBytes: CONFIG.MAX_FILE_GB * GB,
    videoExtensions: Object.keys(VIDEO_TYPES),
    releaseVersion: CONFIG.RELEASE_VERSION,
    releaseText: releaseParagraphs_(),
    prizeText: fillNames_(CONFIG.PRIZE_TEXT),
  };
}

/**
 * Called by the page when someone taps "Send". Validates the form, records the
 * submission in the Sheet, creates a folder for it and one resumable Drive
 * upload per video. The browser then sends the video bytes.
 */
function startSubmission(form) {
  const ids = requireSetup_();
  if (!isAccepting_()) throw new Error('Uploads are paused right now. Please check back soon.');
  form = form || {};
  if (form.website) throw new Error('Something went wrong. Please reload the page and try again.');
  if (form.releaseVersion !== CONFIG.RELEASE_VERSION) {
    throw new Error('This page has been updated. Please reload it and try again.');
  }
  if (form.agreedRelease !== true || form.confirmedAdult !== true) {
    throw new Error('Please confirm you’re 18 or older and agree to the footage release.');
  }

  const creditName = cleanText_(form.creditName, 80);
  const notes = cleanText_(form.notes, 1000, true);
  const email = cleanText_(form.email, 254).toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw new Error('That email address doesn’t look right.');
  if (form.prizeOptIn === true && !email) throw new Error('Add your email to be eligible for prizes.');
  const prizeOptIn = form.prizeOptIn === true;

  const files = validateFiles_(form.files);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  reserveBytes_(totalBytes);
  ensureReleaseLogged_(ids.sheetId);

  const submissionId = newId_(8);
  const started = formatTime_(new Date());
  const folderName = `${started.slice(0, 16)} · ${(creditName || 'Anonymous').replace(/[\/\\]/g, '-')} · ${submissionId}`;
  const folderId = Drive.Files.create({ name: folderName, mimeType: FOLDER_MIME, parents: [ids.folderId] }).id;

  const origin = ALLOWED_ORIGIN_RE.test(String(form.origin || '')) ? form.origin : '';
  const cache = CacheService.getScriptCache();
  const fileNames = files.map((f, i) => `${String(i + 1).padStart(2, '0')} ${f.name}`);
  const uploads = files.map((f, i) => {
    const session = createUploadSession_(fileNames[i], f.type, f.size, folderId, origin);
    const uploadId = newId_(32);
    cache.put(`up_${uploadId}`, JSON.stringify({ uri: session.uri, size: f.size, type: f.type }), CACHE_SECONDS);
    return { uploadId, sessionUri: session.direct ? session.uri : null };
  });

  const row = new Array(SUBMISSION_HEADERS.length).fill('');
  row[COL['Started']] = started;
  row[COL['Submission ID']] = submissionId;
  row[COL['Status']] = 'Uploading';
  row[COL['Credit name']] = creditName;
  row[COL['Email']] = email;
  row[COL['Prize opt-in']] = prizeOptIn ? 'Yes' : 'No';
  row[COL['Notes']] = notes;
  row[COL['Files sent']] = files.length;
  row[COL['Files received']] = 0;
  row[COL['Size (MB)']] = toMb_(totalBytes);
  row[COL['Folder']] = `https://drive.google.com/drive/folders/${folderId}`;
  row[COL['File names']] = fileNames.join('\n');
  row[COL['Release version']] = CONFIG.RELEASE_VERSION;
  row[COL['Agreed to release']] = 'Yes';
  row[COL['Confirmed 18+']] = 'Yes';
  row[COL['Device']] = cleanText_(form.userAgent, 300);
  // RAW input: whatever people type is stored as plain text, never as a formula.
  Sheets.Spreadsheets.Values.append({ values: [row] }, ids.sheetId, `${SUBMISSIONS_TAB}!A1`,
    { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });

  return {
    submissionId,
    uploads,
    directChunkBytes: DIRECT_CHUNK_BYTES,
    relayChunkBytes: RELAY_CHUNK_BYTES,
  };
}

/** Asks Drive how much of an upload has arrived, so the page can resume. */
function uploadStatus(uploadId) {
  const upload = getUpload_(uploadId);
  const res = UrlFetchApp.fetch(upload.uri, {
    method: 'put',
    headers: { 'Content-Range': `bytes */${upload.size}` },
    payload: '',
    muteHttpExceptions: true,
    followRedirects: false,
  });
  return readUploadResponse_(res, upload);
}

/**
 * Fallback path: the page sends a chunk here (base64) and the script forwards
 * it to Drive. Used when the browser can't send straight to Drive.
 */
function relayChunk(uploadId, start, base64) {
  const upload = getUpload_(uploadId);
  const bytes = Utilities.base64Decode(String(base64 || ''));
  if (!Number.isInteger(start) || start < 0 || bytes.length === 0 ||
      bytes.length > RELAY_CHUNK_BYTES || start + bytes.length > upload.size) {
    throw new Error('Upload chunk was invalid. Retrying…');
  }
  const res = UrlFetchApp.fetch(upload.uri, {
    method: 'put',
    contentType: upload.type,
    payload: bytes,
    headers: { 'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${upload.size}` },
    muteHttpExceptions: true,
    followRedirects: false,
  });
  return readUploadResponse_(res, upload);
}

/**
 * Called by the page after the last upload. Counts what actually landed in
 * Drive, updates the Sheet row and sends the emails.
 */
function finishSubmission(submissionId, method) {
  const ids = requireSetup_();
  const rowNumber = findSubmissionRow_(ids.sheetId, String(submissionId || ''));
  if (!rowNumber) throw new Error('We couldn’t find that submission. Please try again.');

  const range = `${SUBMISSIONS_TAB}!A${rowNumber}:${columnLetter_(SUBMISSION_HEADERS.length)}${rowNumber}`;
  const row = (Sheets.Spreadsheets.Values.get(ids.sheetId, range).values || [[]])[0];
  while (row.length < SUBMISSION_HEADERS.length) row.push('');
  const expected = Number(row[COL['Files sent']]) || 0;
  if (row[COL['Status']] === 'Complete') return { status: 'Complete', received: expected, expected };

  const folderMatch = String(row[COL['Folder']]).match(/folders\/([\w-]+)/);
  const files = folderMatch ? listFolder_(folderMatch[1]) : [];
  const receivedBytes = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
  const status = files.length >= expected ? 'Complete' : 'Incomplete';

  row[COL['Status']] = status;
  row[COL['Files received']] = files.length;
  row[COL['Size (MB)']] = toMb_(receivedBytes);
  row[COL['Completed']] = formatTime_(new Date());
  row[COL['Upload method']] = method === 'relay' ? 'relay' : 'direct';
  Sheets.Spreadsheets.Values.update({ values: [row] }, ids.sheetId, range, { valueInputOption: 'RAW' });

  const submission = {
    id: row[COL['Submission ID']],
    creditName: row[COL['Credit name']],
    email: row[COL['Email']],
    prizeOptIn: row[COL['Prize opt-in']] === 'Yes',
    notes: row[COL['Notes']],
    folderUrl: row[COL['Folder']],
    status,
    received: files.length,
    expected,
    receivedBytes,
  };
  notifyOwner_(submission, ids.sheetId);
  if (status === 'Complete') thankContributor_(submission);
  return { status, received: files.length, expected };
}

// --- Drive upload helpers ---------------------------------------------------

function createUploadSession_(name, type, size, parentId, origin) {
  const request = (withOrigin) => {
    const headers = {
      Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
      'X-Upload-Content-Type': type,
      'X-Upload-Content-Length': String(size),
    };
    // Registering the page's origin lets the browser send bytes straight to Drive.
    if (withOrigin) headers.Origin = origin;
    return UrlFetchApp.fetch(UPLOAD_URL, {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify({ name, parents: [parentId], mimeType: type }),
      headers,
      muteHttpExceptions: true,
      followRedirects: false,
    });
  };

  let direct = !!origin;
  let res = null;
  if (direct) {
    try {
      res = request(true);
    } catch (err) {
      console.warn('Upload session with Origin failed; using relay.', err);
    }
  }
  if (!res || res.getResponseCode() !== 200) {
    direct = false;
    res = request(false);
  }
  const uri = header_(res, 'Location');
  if (res.getResponseCode() !== 200 || !uri) {
    console.error('Could not start upload', res.getResponseCode(), res.getContentText());
    throw new Error('We couldn’t start the upload. Please try again in a minute.');
  }
  return { uri, direct };
}

function readUploadResponse_(res, upload) {
  const code = res.getResponseCode();
  if (code === 200 || code === 201) return { done: true, next: upload.size };
  if (code === 308) {
    const range = header_(res, 'Range');
    return { done: false, next: range ? Number(range.split('-')[1]) + 1 : 0 };
  }
  if (code === 404 || code === 410) throw new Error('UPLOAD_EXPIRED');
  console.warn('Upload response', code, res.getContentText());
  throw new Error(`Drive returned an error (${code}). Retrying…`);
}

function getUpload_(uploadId) {
  const cache = CacheService.getScriptCache();
  const key = `up_${String(uploadId || '').replace(/[^A-Z0-9]/g, '')}`;
  const raw = cache.get(key);
  if (!raw) throw new Error('UPLOAD_EXPIRED');
  cache.put(key, raw, CACHE_SECONDS);
  return JSON.parse(raw);
}

function listFolder_(folderId) {
  const files = [];
  let pageToken;
  do {
    const page = Drive.Files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, size)',
      pageSize: 100,
      pageToken,
    });
    files.push(...(page.files || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

function header_(res, name) {
  const headers = res.getAllHeaders();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return '';
  return Array.isArray(headers[key]) ? headers[key][0] : headers[key];
}

// --- Validation and limits ---------------------------------------------------

function validateFiles_(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Pick at least one video.');
  if (files.length > CONFIG.MAX_FILES_PER_SUBMISSION) {
    throw new Error(`You can send up to ${CONFIG.MAX_FILES_PER_SUBMISSION} videos at a time.`);
  }
  return files.map((f) => {
    const name = cleanText_(f && f.name, 120).replace(/[\/\\]/g, '-') || 'video';
    const size = Number(f && f.size);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
    const extType = VIDEO_TYPES[(ext || '').toLowerCase()];
    const givenType = String((f && f.type) || '');
    if (!givenType.startsWith('video/') && !extType) throw new Error(`“${name}” doesn’t look like a video.`);
    if (!Number.isInteger(size) || size <= 0) throw new Error(`“${name}” looks empty.`);
    if (size > CONFIG.MAX_FILE_GB * GB) throw new Error(`“${name}” is over ${CONFIG.MAX_FILE_GB} GB.`);
    return { name, size, type: givenType.startsWith('video/') ? givenType : extType };
  });
}

/** Counts a submission against the daily and hourly caps, or refuses it. */
function reserveBytes_(bytes) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const now = Date.now();
    const dayKey = `BYTES_${Utilities.formatDate(new Date(now), Session.getScriptTimeZone(), 'yyyy-MM-dd')}`;
    const usedToday = Number(props.getProperty(dayKey)) || 0;
    if (usedToday + bytes > CONFIG.DAILY_LIMIT_GB * GB) {
      alertOwnerOnce_('DAILY', dayKey, `the daily cap of ${CONFIG.DAILY_LIMIT_GB} GB`);
      throw new Error(CONFIG.DAILY_LIMIT_MESSAGE);
    }

    // The last hour, kept as 5-minute buckets: { "<bucket start in ms>": bytes }.
    const bucketMs = 5 * 60 * 1000;
    const recent = JSON.parse(props.getProperty('RECENT_BYTES') || '{}');
    Object.keys(recent).forEach((start) => {
      if (Number(start) <= now - 60 * 60 * 1000) delete recent[start];
    });
    const usedThisHour = Object.keys(recent).reduce((sum, start) => sum + recent[start], 0);
    if (usedThisHour + bytes > CONFIG.HOURLY_LIMIT_GB * GB) {
      alertOwnerOnce_('HOURLY', String(Math.floor(now / (60 * 60 * 1000))), `the hourly cap of ${CONFIG.HOURLY_LIMIT_GB} GB`);
      throw new Error(CONFIG.HOURLY_LIMIT_MESSAGE);
    }

    const bucket = String(Math.floor(now / bucketMs) * bucketMs);
    recent[bucket] = (recent[bucket] || 0) + bytes;
    props.setProperties({ [dayKey]: String(usedToday + bytes), RECENT_BYTES: JSON.stringify(recent) });
    Object.keys(props.getProperties())
      .filter((k) => k.startsWith('BYTES_') && k !== dayKey)
      .forEach((k) => props.deleteProperty(k));
  } finally {
    lock.releaseLock();
  }
}

/** Emails the owner the first time a cap is hit in each period. */
function alertOwnerOnce_(kind, period, capName) {
  const props = PropertiesService.getScriptProperties();
  const key = `ALERTED_${kind}`;
  if (props.getProperty(key) === period) return;
  props.setProperty(key, period);
  const to = CONFIG.NOTIFY_EMAIL || props.getProperty('OWNER_EMAIL');
  if (!to) return;
  sendMail_({
    to,
    subject: `${CONFIG.BRAND_NAME} uploads hit ${capName}`,
    body: `The upload page just turned someone away because it reached ${capName}.\n\n` +
      'If this is a real rush, you can raise DAILY_LIMIT_GB or HOURLY_LIMIT_GB in Code.gs and deploy a new version. ' +
      'If it looks like spam, run pauseUploads in the Apps Script editor to close the page.',
  });
}

/** Run from the editor to close the upload page right away. No redeploy needed. */
function pauseUploads() {
  PropertiesService.getScriptProperties().setProperty('PAUSED', 'yes');
  console.log('Uploads are paused. Run resumeUploads to reopen the page.');
}

/** Run from the editor to reopen the upload page after pauseUploads. */
function resumeUploads() {
  PropertiesService.getScriptProperties().deleteProperty('PAUSED');
  console.log('Uploads are open again.');
}

function isAccepting_() {
  return CONFIG.ACCEPTING_UPLOADS && !PropertiesService.getScriptProperties().getProperty('PAUSED');
}

function requireSetup_() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('FOLDER_ID');
  const sheetId = props.getProperty('SHEET_ID');
  if (!folderId || !sheetId) throw new Error('This page isn’t set up yet. Please check back soon.');
  return { folderId, sheetId };
}

function isUsable_(fileId) {
  try {
    return !Drive.Files.get(fileId, { fields: 'id, trashed' }).trashed;
  } catch (err) {
    return false;
  }
}

// --- Sheet helpers -------------------------------------------------------------

function writeRow_(sheetId, range, values) {
  Sheets.Spreadsheets.Values.update({ values: [values] }, sheetId, range, { valueInputOption: 'RAW' });
}

function findSubmissionRow_(sheetId, submissionId) {
  if (!submissionId) return 0;
  const ids = Sheets.Spreadsheets.Values.get(sheetId, `${SUBMISSIONS_TAB}!B:B`).values || [];
  for (let i = ids.length - 1; i > 0; i--) {
    if (ids[i][0] === submissionId) return i + 1;
  }
  return 0;
}

/** Keeps a copy of every release wording people have agreed to. */
function ensureReleaseLogged_(sheetId) {
  const props = PropertiesService.getScriptProperties();
  const logged = (props.getProperty('RELEASES_LOGGED') || '').split('|');
  if (logged.includes(CONFIG.RELEASE_VERSION)) return;
  Sheets.Spreadsheets.Values.append(
    { values: [[CONFIG.RELEASE_VERSION, formatTime_(new Date()), releaseParagraphs_().join('\n\n')]] },
    sheetId, `'${RELEASES_TAB}'!A1`, { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
  props.setProperty('RELEASES_LOGGED', logged.concat(CONFIG.RELEASE_VERSION).filter(Boolean).join('|'));
}

function columnLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// --- Email ---------------------------------------------------------------------

function notifyOwner_(s, sheetId) {
  if (!CONFIG.NOTIFY_OWNER) return;
  const to = CONFIG.NOTIFY_EMAIL || PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL');
  if (!to) return;
  const lines = [
    `${s.received} of ${s.expected} video(s), ${toMb_(s.receivedBytes)} MB. Status: ${s.status}.`,
    '',
    `Credit name: ${s.creditName || '(none)'}`,
    `Email: ${s.email || '(none)'}${s.prizeOptIn ? ' (prize opt-in)' : ''}`,
    `Notes: ${s.notes || '(none)'}`,
    '',
    `Footage: ${s.folderUrl}`,
    `All submissions: https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
  ];
  sendMail_({
    to,
    subject: `New footage for ${CONFIG.BRAND_NAME} from ${s.creditName || 'Anonymous'} (${s.id})`,
    body: lines.join('\n'),
  });
}

function thankContributor_(s) {
  if (!CONFIG.SEND_THANK_YOU || !s.email) return;
  const lines = [
    `Hi${s.creditName ? ` ${s.creditName}` : ''},`,
    '',
    `Thanks for sending your footage to ${CONFIG.BRAND_NAME}! We received ${s.received} video(s).`,
    s.prizeOptIn ? 'You’re on the list for future prize giveaways. We’ll email you if one comes up.' : '',
    '',
    `Watch for it: ${CONFIG.YOUTUBE_URL}`,
    '',
    `${CONFIG.BRAND_NAME}`,
    `Reference: ${s.id}`,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '');
  sendMail_({ to: s.email, subject: `Got your footage! Thanks from ${CONFIG.BRAND_NAME}`, body: lines.join('\n') });
}

function sendMail_(message) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) {
      console.warn('Daily email quota used up; skipped', message.subject);
      return;
    }
    MailApp.sendEmail(Object.assign({ name: CONFIG.BRAND_NAME }, message));
  } catch (err) {
    console.warn('Email failed', err);
  }
}

// --- Small utilities -----------------------------------------------------------

function releaseParagraphs_() {
  return CONFIG.RELEASE_TEXT.map(fillNames_);
}

function fillNames_(text) {
  return text.replace(/\{RIGHTS_HOLDER\}/g, CONFIG.RIGHTS_HOLDER).replace(/\{BRAND_NAME\}/g, CONFIG.BRAND_NAME);
}

function cleanText_(value, maxLength, keepNewlines) {
  const controls = keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return String(value == null ? '' : value).replace(controls, ' ').trim().slice(0, maxLength);
}

function newId_(length) {
  return Utilities.getUuid().replace(/-/g, '').toUpperCase().slice(0, length);
}

function formatTime_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function toMb_(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
