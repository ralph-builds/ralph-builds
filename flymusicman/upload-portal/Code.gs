/**
 * Very Simple Video Uploads.
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
  BRAND_NAME: 'FLYfx',
  // The person or business that gets permission to use the footage. Use the legal name.
  RIGHTS_HOLDER: 'FLYfx',
  // Linked in the contributor thank-you email.
  WEBSITE_URL: 'https://flyfx.net',
  // The page itself stays unbranded. This is the only place the brand shows:
  // a "Brought to you by" line at the bottom. Leave BROUGHT_BY blank and it reads
  // "Brought to you by FLYfx".
  BROUGHT_BY: '',
  BROUGHT_BY_URL: '',
  // Where people can write to ask for a video to be left out of anything new.
  CONTACT_EMAIL: 'jarvis@flyfx.net',
  // The line under the headline, shown once people are past the terms screen.
  INTRO_TEXT: 'Clips may be used in videos and posts, with credit if you opt in.',

  // Set to false to close the page to new uploads (it shows a "paused" note).
  // To pause without redeploying, run pauseUploads (and resumeUploads to reopen).
  ACCEPTING_UPLOADS: true,
  MAX_FILES_PER_SUBMISSION: 10,
  MAX_FILE_GB: 5,
  // Total accepted per day across everyone. Google Drive's own cap is 750 GB/day.
  DAILY_LIMIT_GB: 200,
  // Total accepted in any 60 minutes, so one burst can't use up the whole day.
  HOURLY_LIMIT_GB: 50,
  // Most that one send may declare across all its videos.
  MAX_SUBMISSION_GB: 20,
  // How many sends may start, across everyone. Stops floods of tiny sends.
  MAX_SENDS_PER_HOUR: 300,
  MAX_SENDS_PER_DAY: 2000,
  // A send that stops receiving data for this long has its upload links
  // cancelled. Its reserved space is returned only once Drive confirms those
  // links can no longer accept data.
  STALL_MINUTES: 15,
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

  // The terms people agree to on the first screen. Change RELEASE_VERSION
  // whenever you change the wording, so the Sheet records exactly which wording
  // each person agreed to (and returning visitors are asked again).
  TERMS_NAME: 'Footage Terms',
  RELEASE_VERSION: '2026-10-31-v3',
  // Opening splash. Blank shows the built-in Very Simple Video Uploads title card;
  // a full https:// image link shows that image full screen instead (a client's photo or logo).
  SPLASH_IMAGE_URL: '',

  // The first screen: a heading, one plain-English line above the checkbox and the button.
  DOOR_TITLE: 'Thanks for sharing your footage!',
  RELEASE_SUMMARY: 'Quick OK first: your footage stays yours. You are simply giving permission to use it, with credit if you want it.',
  DOOR_BUTTON: 'I’m in',
  RELEASE_TEXT: [
    'You keep ownership. Your videos stay yours. Sending them here doesn’t change that, and you can still share them anywhere you like.',
    'You give permission. {RIGHTS_HOLDER} may use, edit and share your videos, in whole or in part, in videos and posts on YouTube, social media and anywhere else {RIGHTS_HOLDER} shares its work. This permission is free, worldwide and doesn’t expire, so anything already posted can stay up.',
    'It’s yours to share. You shot the videos yourself, and anyone clearly recognizable in them was OK being filmed.',
    'No payment, credit when we can. There’s no payment. We’ll credit you using the name you leave, whenever we can.',
    'Changed your mind? Email {CONTACT_EMAIL} and we’ll leave the video out of anything new.',
  ],
  PRIZE_TEXT: 'Leave your email to be eligible for future prize giveaways. Any giveaway will have its own official rules, posted before it starts. Your email is only used for giveaways, your footage and the newsletter if you sign up. It’s never sold or shared.',
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
  'Upload method', 'Newsletter opt-in',
];
const COL = SUBMISSION_HEADERS.reduce((map, name, i) => (map[name] = i, map), {});

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id';
// Resumable upload chunks must be multiples of 256 KiB.
const DIRECT_CHUNK_BYTES = 8 * 1024 * 1024;
const RELAY_CHUNK_BYTES = 4 * 1024 * 1024;
const CACHE_SECONDS = 6 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;
const BUCKET_MS = 5 * 60 * 1000;
// Unsettled sends are listed in one Script property; keep it under the 9 KB limit.
const PENDING_KEY = 'PENDING';
const PENDING_MAX = 60;
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
 * Run once from the editor, before the first deployment. Creates the uploads
 * folder and the log Sheet (inside that folder).
 *
 * Every function without a trailing underscore can be called by anyone through
 * the deployed web app, so once both IDs are stored this does nothing at all.
 * To repair a missing folder or Sheet, the owner deletes FOLDER_ID or SHEET_ID
 * under Project Settings > Script properties, then runs setup again.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('FOLDER_ID') && props.getProperty('SHEET_ID')) {
    console.log('Already set up. Nothing changed.');
    return;
  }
  setup_();
}

function setup_() {
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
    .setTitle(`Very Simple Video Uploads · ${CONFIG.BRAND_NAME}`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function publicConfig_() {
  const ready = !!PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  return {
    rightsHolder: CONFIG.RIGHTS_HOLDER,
    splashImage: /^https:\/\//.test(CONFIG.SPLASH_IMAGE_URL) ? CONFIG.SPLASH_IMAGE_URL : '',
    broughtBy: CONFIG.BROUGHT_BY,
    broughtByUrl: CONFIG.BROUGHT_BY_URL,
    accepting: isAccepting_() && ready,
    maxFiles: CONFIG.MAX_FILES_PER_SUBMISSION,
    maxFileBytes: CONFIG.MAX_FILE_GB * GB,
    videoExtensions: Object.keys(VIDEO_TYPES),
    releaseVersion: CONFIG.RELEASE_VERSION,
    termsName: CONFIG.TERMS_NAME,
    doorTitle: fillNames_(CONFIG.DOOR_TITLE),
    releaseSummary: fillNames_(CONFIG.RELEASE_SUMMARY),
    doorButton: CONFIG.DOOR_BUTTON,
    releaseText: releaseParagraphs_(),
    introText: fillNames_(CONFIG.INTRO_TEXT),
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
    throw new Error(`Please confirm you’re 18 or older and agree to the ${CONFIG.TERMS_NAME}.`);
  }

  const creditName = cleanText_(form.creditName, 80);
  const notes = cleanText_(form.notes, 1000, true);
  const email = cleanText_(form.email, 254).toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw new Error('That email address doesn’t look right.');
  if ((form.prizeOptIn === true || form.newsletterOptIn === true) && !email) throw new Error('Add your email so we can reach you.');
  const prizeOptIn = form.prizeOptIn === true;
  const newsletterOptIn = form.newsletterOptIn === true;

  const files = validateFiles_(form.files);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > CONFIG.MAX_SUBMISSION_GB * GB) {
    throw new Error(`That’s more than ${CONFIG.MAX_SUBMISSION_GB} GB in one go. Please send fewer or shorter videos.`);
  }
  settleStalled_();
  const charge = admit_(totalBytes);

  const submissionId = newId_(8);
  const started = formatTime_(new Date());
  const origin = ALLOWED_ORIGIN_RE.test(String(form.origin || '')) ? form.origin : '';
  const cache = CacheService.getScriptCache();
  const fileNames = files.map((f, i) => `${String(i + 1).padStart(2, '0')} ${f.name}`);
  const sessions = [];
  let uploads;
  let folderId;
  try {
    ensureReleaseLogged_(ids.sheetId);
    ensureHeaders_(ids.sheetId);
    const folderName = `${started.slice(0, 16)} · ${(creditName || 'Anonymous').replace(/[\/\\]/g, '-')} · ${submissionId}`;
    folderId = Drive.Files.create({ name: folderName, mimeType: FOLDER_MIME, parents: [ids.folderId] }).id;
    uploads = files.map((f, i) => {
      const session = createUploadSession_(fileNames[i], f.type, f.size, folderId, origin);
      sessions.push({ u: session.uri, s: f.size });
      const uploadId = newId_(32);
      cache.put(`up_${uploadId}`, JSON.stringify({ uri: session.uri, size: f.size, type: f.type }), CACHE_SECONDS);
      return { uploadId, sessionUri: session.direct ? session.uri : null };
    });
  } catch (err) {
    rollBackStart_(charge, totalBytes, sessions);
    throw err;
  }
  recordPending_(submissionId, charge, sessions);

  const row = new Array(SUBMISSION_HEADERS.length).fill('');
  row[COL['Started']] = started;
  row[COL['Submission ID']] = submissionId;
  row[COL['Status']] = 'Uploading';
  row[COL['Credit name']] = creditName;
  row[COL['Email']] = email;
  row[COL['Prize opt-in']] = prizeOptIn ? 'Yes' : 'No';
  row[COL['Newsletter opt-in']] = newsletterOptIn ? 'Yes' : 'No';
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
    finishToken: finishToken_(submissionId),
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
 * Drive, updates the Sheet row and sends the emails. Needs the token that
 * startSubmission returned, and only does its work once per submission.
 */
function finishSubmission(submissionId, method, finishToken) {
  const ids = requireSetup_();
  submissionId = String(submissionId || '');
  if (!submissionId || String(finishToken || '') !== finishToken_(submissionId)) {
    throw new Error('We couldn’t find that submission. Please try again.');
  }
  // One finish at a time, so a double tap or retry can't send the emails twice.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let result;
  try {
    result = finishSubmissionLocked_(ids, submissionId, method);
  } finally {
    lock.releaseLock();
  }
  if (result.status === 'Complete') {
    // Every video landed, so every byte reserved was used: nothing to hand back.
    CacheService.getScriptCache().remove(`pend_${submissionId}`);
    dropPending_(submissionId);
  } else {
    // The page has stopped sending: cancel any upload links that never finished
    // and hand back their reserved space once Drive confirms they're closed.
    settlePending_(submissionId, 'finish');
  }
  return result;
}

function finishSubmissionLocked_(ids, submissionId, method) {
  const rowNumber = findSubmissionRow_(ids.sheetId, submissionId);
  if (!rowNumber) throw new Error('We couldn’t find that submission. Please try again.');

  const range = `${SUBMISSIONS_TAB}!A${rowNumber}:${columnLetter_(SUBMISSION_HEADERS.length)}${rowNumber}`;
  const row = (Sheets.Spreadsheets.Values.get(ids.sheetId, range).values || [[]])[0];
  while (row.length < SUBMISSION_HEADERS.length) row.push('');
  const expected = Number(row[COL['Files sent']]) || 0;
  if (row[COL['Status']] !== 'Uploading') {
    return { status: row[COL['Status']], received: Number(row[COL['Files received']]) || 0, expected };
  }

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
    newsletterOptIn: row[COL['Newsletter opt-in']] === 'Yes',
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
  if (code === 404 || code === 410 || code === 499) throw new Error('UPLOAD_EXPIRED');
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

/**
 * Admission control. Under one lock, refuses a send if it would go over the
 * daily or hourly byte caps or the daily or hourly count of sends, and
 * otherwise reserves its declared bytes and counts it. Returns where the bytes
 * were charged, so a confirmed-unused part can be handed back later.
 */
function admit_(bytes) {
  return withLock_(() => {
    const props = PropertiesService.getScriptProperties();
    const now = Date.now();
    const day = dayStamp_(now);
    const dayKey = `BYTES_${day}`;
    const startsKey = `STARTS_${day}`;
    const usedToday = Number(props.getProperty(dayKey)) || 0;
    const startsToday = Number(props.getProperty(startsKey)) || 0;
    if (usedToday + bytes > CONFIG.DAILY_LIMIT_GB * GB || startsToday + 1 > CONFIG.MAX_SENDS_PER_DAY) {
      alertOwnerOnce_('DAILY', dayKey, `the daily cap of ${CONFIG.DAILY_LIMIT_GB} GB or ${CONFIG.MAX_SENDS_PER_DAY} sends`);
      throw new Error(CONFIG.DAILY_LIMIT_MESSAGE);
    }

    // The last hour, kept as 5-minute buckets: { "<bucket start in ms>": amount }.
    const recentBytes = lastHour_(props.getProperty('RECENT_BYTES'), now);
    const recentStarts = lastHour_(props.getProperty('RECENT_STARTS'), now);
    const sum = (o) => Object.keys(o).reduce((t, k) => t + o[k], 0);
    if (sum(recentBytes) + bytes > CONFIG.HOURLY_LIMIT_GB * GB || sum(recentStarts) + 1 > CONFIG.MAX_SENDS_PER_HOUR) {
      alertOwnerOnce_('HOURLY', String(Math.floor(now / HOUR_MS)), `the hourly cap of ${CONFIG.HOURLY_LIMIT_GB} GB or ${CONFIG.MAX_SENDS_PER_HOUR} sends`);
      throw new Error(CONFIG.HOURLY_LIMIT_MESSAGE);
    }

    const bucket = String(Math.floor(now / BUCKET_MS) * BUCKET_MS);
    recentBytes[bucket] = (recentBytes[bucket] || 0) + bytes;
    recentStarts[bucket] = (recentStarts[bucket] || 0) + 1;
    props.setProperties({
      [dayKey]: String(usedToday + bytes),
      [startsKey]: String(startsToday + 1),
      RECENT_BYTES: JSON.stringify(recentBytes),
      RECENT_STARTS: JSON.stringify(recentStarts),
    });
    Object.keys(props.getProperties())
      .filter((k) => (k.startsWith('BYTES_') && k !== dayKey) || (k.startsWith('STARTS_') && k !== startsKey))
      .forEach((k) => props.deleteProperty(k));
    return { d: dayKey, b: bucket };
  });
}

/** Hands back reserved bytes, but only to a day or hour window that is still current. */
function refundBytes_(charge, bytes) {
  if (bytes > 0) withLock_(() => refundBytesLocked_(charge, bytes));
}

/**
 * startSubmission failed after reserving: bytes for videos that never got an
 * upload link are returned at once; links that were made are cancelled and
 * their bytes returned only if Drive confirms they're closed.
 */
function rollBackStart_(charge, totalBytes, sessions) {
  let refund = totalBytes - sessions.reduce((t, x) => t + x.s, 0);
  sessions.forEach((x) => { if (cancelUpload_(x.u, x.s)) refund += x.s; });
  refundBytes_(charge, refund);
}

/** Notes an unsettled send: its charge in the index, its upload links in the cache. */
function recordPending_(submissionId, charge, sessions) {
  CacheService.getScriptCache().put(`pend_${submissionId}`, JSON.stringify(sessions), CACHE_SECONDS);
  withLock_(() => {
    const now = Date.now();
    const list = readPending_().filter((e) => e.d === `BYTES_${dayStamp_(now)}`);
    list.push({ s: submissionId, d: charge.d, b: charge.b, c: now, p: 0 });
    // If the list is full, the oldest are forgotten: their space just stays reserved.
    writePending_(list.slice(-PENDING_MAX));
  });
}

/**
 * Settles one send. 'finish': the page is done, so any link that hasn't
 * finished is cancelled. 'sweep': links are only cancelled if no new data
 * arrived since the last check. Either way, a video's bytes are returned only
 * after Drive reports its link closed (404, 410 or 499). A finished video keeps
 * its charge (Drive won't take more than the size declared for it).
 */
function settlePending_(submissionId, mode) {
  const cache = CacheService.getScriptCache();
  const key = `pend_${submissionId}`;
  const sessions = JSON.parse(cache.get(key) || 'null');
  if (!sessions) return dropPending_(submissionId);

  const entry = readPending_().find((e) => e.s === submissionId);
  const states = sessions.map((x) => probeUpload_(x.u, x.s));
  const received = states.reduce((t, st) => t + (typeof st === 'number' ? st : 0), 0);
  const progressing = mode === 'sweep' && entry && received > entry.p;
  const closed = [];
  sessions.forEach((x, i) => {
    if (states[i] === 'done') return;
    if (states[i] === 'dead' || (!progressing && cancelUpload_(x.u, x.s))) closed.push(x.u);
  });

  withLock_(() => {
    // Re-read under the lock, so a finish and a sweep can't both refund the same video.
    const current = JSON.parse(cache.get(key) || 'null');
    if (!current) return;
    const refund = current.filter((x) => closed.includes(x.u)).reduce((t, x) => t + x.s, 0);
    const left = current.filter((x, i) => !closed.includes(x.u) && states[sessions.findIndex((y) => y.u === x.u)] !== 'done');
    const list = readPending_();
    const e = list.find((x) => x.s === submissionId);
    if (e && refund) refundBytesLocked_(e, refund);
    if (!left.length) {
      cache.remove(key);
      writePending_(list.filter((x) => x.s !== submissionId));
    } else {
      cache.put(key, JSON.stringify(left), CACHE_SECONDS);
      if (e) { e.c = Date.now(); e.p = received; writePending_(list); }
    }
  });
}

/** Checks a few sends that have gone quiet for STALL_MINUTES, oldest first. */
function settleStalled_() {
  const stallMs = CONFIG.STALL_MINUTES * 60 * 1000;
  const claimed = withLock_(() => {
    const now = Date.now();
    const list = readPending_().filter((e) => e.d === `BYTES_${dayStamp_(now)}`);
    const due = list.filter((e) => now - e.c >= stallMs).slice(0, 2);
    due.forEach((e) => { e.c = now; }); // claim them so a parallel request skips them
    writePending_(list);
    return due.map((e) => e.s);
  });
  claimed.forEach((sid) => settlePending_(sid, 'sweep'));
}

function dropPending_(submissionId) {
  withLock_(() => writePending_(readPending_().filter((e) => e.s !== submissionId)));
}

/** 'done', 'dead', or the number of bytes Drive has received so far. */
function probeUpload_(uri, size) {
  try {
    const res = UrlFetchApp.fetch(uri, {
      method: 'put', headers: { 'Content-Range': `bytes */${size}` }, payload: '',
      muteHttpExceptions: true, followRedirects: false,
    });
    const code = res.getResponseCode();
    if (code === 200 || code === 201) return 'done';
    if (code === 404 || code === 410 || code === 499) return 'dead';
    if (code === 308) {
      const range = header_(res, 'Range');
      return range ? Number(range.split('-')[1]) + 1 : 0;
    }
  } catch (err) {
    console.warn('Upload status check failed', err);
  }
  return 'unknown';
}

/** Asks Drive to cancel an upload link, then checks. True only if it's confirmed closed. */
function cancelUpload_(uri, size) {
  try {
    UrlFetchApp.fetch(uri, { method: 'delete', muteHttpExceptions: true, followRedirects: false });
  } catch (err) {
    console.warn('Upload cancel failed', err);
  }
  return probeUpload_(uri, size) === 'dead';
}

function readPending_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty(PENDING_KEY) || '[]');
}

function writePending_(list) {
  PropertiesService.getScriptProperties().setProperty(PENDING_KEY, JSON.stringify(list));
}

/** refundBytes_ for callers that already hold the lock. */
function refundBytesLocked_(charge, bytes) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const updates = {};
  if (charge.d === `BYTES_${dayStamp_(now)}`) {
    updates[charge.d] = String(Math.max(0, (Number(props.getProperty(charge.d)) || 0) - bytes));
  }
  const recent = lastHour_(props.getProperty('RECENT_BYTES'), now);
  if (recent[charge.b] !== undefined) {
    recent[charge.b] = Math.max(0, recent[charge.b] - bytes);
    updates.RECENT_BYTES = JSON.stringify(recent);
  }
  if (Object.keys(updates).length) props.setProperties(updates);
}

function lastHour_(json, now) {
  const buckets = JSON.parse(json || '{}');
  Object.keys(buckets).forEach((start) => { if (Number(start) <= now - HOUR_MS) delete buckets[start]; });
  return buckets;
}

function dayStamp_(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
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
      'If it looks like spam, pause new uploads: in the Apps Script editor open Project Settings > ' +
      'Script properties and add a property named PAUSED with the value yes. Delete it to reopen.',
  });
}

/**
 * The owner pauses new uploads by adding a Script property named PAUSED with
 * the value yes (Project Settings > Script properties), and reopens them by
 * deleting it. Only people who can edit this project can change Script
 * properties, so there is deliberately no function for this: any function
 * without a trailing underscore can be called by anyone through the web app.
 */
function isAccepting_() {
  const paused = String(PropertiesService.getScriptProperties().getProperty('PAUSED') || '').trim().toLowerCase();
  return CONFIG.ACCEPTING_UPLOADS && !['yes', 'true', '1'].includes(paused);
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

/** Adds any new column headers to an existing Sheet (new columns go on the end). */
function ensureHeaders_(sheetId) {
  const props = PropertiesService.getScriptProperties();
  const key = SUBMISSION_HEADERS.join('|');
  if (props.getProperty('HEADERS') === key) return;
  writeRow_(sheetId, `${SUBMISSIONS_TAB}!A1`, SUBMISSION_HEADERS);
  props.setProperty('HEADERS', key);
}

/** Keeps a copy of every release wording people have agreed to. */
function ensureReleaseLogged_(sheetId) {
  const props = PropertiesService.getScriptProperties();
  const logged = (props.getProperty('RELEASES_LOGGED') || '').split('|');
  if (logged.includes(CONFIG.RELEASE_VERSION)) return;
  Sheets.Spreadsheets.Values.append(
    { values: [[CONFIG.RELEASE_VERSION, formatTime_(new Date()), [fillNames_(CONFIG.RELEASE_SUMMARY)].concat(releaseParagraphs_()).join('\n\n')]] },
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
    `Email: ${s.email || '(none)'}${[s.prizeOptIn && 'prizes', s.newsletterOptIn && 'newsletter'].filter(Boolean).map((x) => ` (${x} opt-in)`).join('')}`,
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
    s.newsletterOptIn ? 'You’re signed up for the FLYfx newsletter. It’s coming soon.' : '',
    '',
    `More at ${CONFIG.WEBSITE_URL}`,
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
  return text
    .replace(/\{RIGHTS_HOLDER\}/g, CONFIG.RIGHTS_HOLDER)
    .replace(/\{BRAND_NAME\}/g, CONFIG.BRAND_NAME)
    .replace(/\{CONTACT_EMAIL\}/g, CONFIG.CONTACT_EMAIL);
}

function cleanText_(value, maxLength, keepNewlines) {
  const controls = keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return String(value == null ? '' : value).replace(controls, ' ').trim().slice(0, maxLength);
}

/** A token only this script can produce for a submission ID (HMAC with a stored secret). */
function finishToken_(submissionId) {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('FINISH_SECRET');
  if (!secret) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      secret = props.getProperty('FINISH_SECRET');
      if (!secret) {
        secret = Utilities.getUuid() + Utilities.getUuid();
        props.setProperty('FINISH_SECRET', secret);
      }
    } finally {
      lock.releaseLock();
    }
  }
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(submissionId, secret));
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
