// Isolated security test: Code.gs runs against in-memory fakes of Google services.
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'Code.gs'), 'utf8');
let failures = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++; };

function world(initialProps) {
  const props = Object.assign({}, initialProps);
  const log = { drive: 0, mails: [], rows: [['Started']], sessions: {}, folders: {} };
  let uuid = 0;
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, JSON, Object, Number, String, Math, Error, Array, Date, Buffer,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      setProperties: (o) => Object.entries(o).forEach(([k, v]) => { props[k] = String(v); }), deleteProperty: (k) => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: {
      formatDate: () => '2026-11-01', getUuid: () => crypto.randomUUID ? crypto.randomUUID() : String(++uuid),
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', k).update(v).digest()].map((b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
    },
    CacheService: { getScriptCache: () => { const c = (globalThis.__cache = globalThis.__cache || {}); return { put: (k, v) => { c[k] = v; }, get: (k) => c[k] || null, remove: (k) => { delete c[k]; } }; } },
    ScriptApp: { getOAuthToken: () => 'token' },
    Drive: { Files: {
      create: (meta) => { log.drive++; const id = 'ID' + (++uuid); if (meta.mimeType && meta.mimeType.endsWith('folder')) log.folders[id] = []; return { id }; },
      get: () => { log.drive++; return { id: 'x', trashed: false }; },
      list: (o) => { log.drive++; const fid = o.q.match(/'([^']+)'/)[1]; return { files: (log.folders[fid] || []) }; },
    } },
    Sheets: { Spreadsheets: {
      get: () => ({ sheets: [{ properties: { sheetId: 0 } }] }), batchUpdate: () => ({}),
      Values: {
        append: (v, id, range) => { if (range.startsWith('Submissions')) log.rows.push(v.values[0].slice()); },
        update: (v, id, range) => { const m = range.match(/A(\d+):/); if (m) log.rows[Number(m[1]) - 1] = v.values[0].slice(); },
        get: (id, range) => { if (range.endsWith('B:B')) return { values: log.rows.map((r) => [r[1]]) };
          const n = Number(range.match(/A(\d+):/)[1]); return { values: [log.rows[n - 1].slice()] }; },
      },
    } },
    UrlFetchApp: { fetch: (url, opt) => {
      if (url.startsWith('https://www.googleapis.com/upload')) {
        const p = JSON.parse(opt.payload); const sid = 'https://upload.example/s' + (++uuid);
        log.sessions[sid] = { parent: p.parents[0], name: p.name, got: 0 };
        return { getResponseCode: () => 200, getAllHeaders: () => ({ Location: sid }), getContentText: () => '' };
      }
      if (opt.method === 'delete') return { getResponseCode: () => 405, getAllHeaders: () => ({}), getContentText: () => '' };
      const s = log.sessions[url]; const size = Number(opt.headers['Content-Range'].split('/')[1]);
      if (opt.payload && opt.payload.length) s.got += opt.payload.length;
      if (s.got >= size) { if (!s.done) { s.done = true; log.folders[s.parent].push({ id: 'f', name: s.name, size: String(size) }); }
        return { getResponseCode: () => 200, getAllHeaders: () => ({}), getContentText: () => '{}' }; }
      return { getResponseCode: () => 308, getAllHeaders: () => (s.got ? { Range: 'bytes=0-' + (s.got - 1) } : {}), getContentText: () => '' };
    } },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: (m) => log.mails.push(m.to + ' | ' + m.subject) },
    HtmlService: {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, props, log };
}

// 1. What google.script.run can reach: every top-level function whose name doesn't end in "_".
const declared = [...SRC.matchAll(/^function ([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
const callable = declared.filter((n) => !n.endsWith('_')).sort();
console.log('Callable from the web app:', callable.join(', '));
check(JSON.stringify(callable) === JSON.stringify(['doGet', 'finishSubmission', 'relayChunk', 'setup', 'startSubmission', 'uploadStatus']), 'only the 5 upload functions plus first-run setup are public');
check(!declared.includes('pauseUploads') && !declared.includes('resumeUploads'), 'pauseUploads/resumeUploads no longer exist');

const LIVE = { FOLDER_ID: 'LIVE_FOLDER', SHEET_ID: 'LIVE_SHEET', OWNER_EMAIL: 'owner@example.com', RELEASES_LOGGED: '2026-10-31-v3' };
const form = (extra) => Object.assign({ agreedRelease: true, confirmedAdult: true, releaseVersion: '2026-10-31-v3', email: 'fan@example.com',
  files: [{ name: 'clip.mov', size: 1000, type: 'video/quicktime' }] }, extra);
const sendAll = (ctx, up, size) => { const b64 = Buffer.alloc(size, 7).toString('base64'); return ctx.relayChunk(up.uploadId, 0, b64); };

// 2. Anonymous call to setup on the configured (live-like) app changes nothing.
{ const w = world(LIVE); const before = JSON.stringify(w.props);
  w.ctx.setup(); check(JSON.stringify(w.props) === before && w.log.drive === 0, 'setup() on a configured app: no property change, no Drive calls'); }

// 3. First-run setup still works on an empty project.
{ const w = world({}); w.ctx.setup(); check(!!w.props.FOLDER_ID && !!w.props.SHEET_ID, 'setup() on a brand-new project creates folder + Sheet'); }

// 4. Legitimate upload end to end.
{ const w = world(LIVE); globalThis.__cache = {};
  const s = w.ctx.startSubmission(form());
  check(typeof s.finishToken === 'string' && s.finishToken.length > 20, 'startSubmission returns a finish token');
  const r1 = sendAll(w.ctx, s.uploads[0], 1000); check(r1.done === true, 'relayChunk completes the upload');
  const f = w.ctx.finishSubmission(s.submissionId, 'relay', s.finishToken);
  check(f.status === 'Complete' && f.received === 1, 'finishSubmission with token -> Complete');
  check(w.log.mails.length === 2, 'owner notified + fan thanked (2 emails)');
  w.ctx.finishSubmission(s.submissionId, 'relay', s.finishToken);
  check(w.log.mails.length === 2, 'repeat finish sends no more emails');
  check(w.props.FOLDER_ID === 'LIVE_FOLDER' && w.props.SHEET_ID === 'LIVE_SHEET', 'folder and Sheet IDs untouched'); }

// 5. Someone else's submission ID without the right token is refused and changes nothing.
{ const w = world(LIVE); globalThis.__cache = {};
  const victim = w.ctx.startSubmission(form());
  const rowBefore = JSON.stringify(w.log.rows);
  let msgs = [];
  for (const tok of [undefined, '', 'guess', victim.finishToken.slice(0, -2) + 'AA']) {
    try { w.ctx.finishSubmission(victim.submissionId, 'direct', tok); msgs.push('ACCEPTED'); } catch (e) { msgs.push('refused'); } }
  check(msgs.every((m) => m === 'refused'), 'finish without the right token is refused (4 attempts)');
  check(JSON.stringify(w.log.rows) === rowBefore && w.log.mails.length === 0, '...and the row and emails are unchanged');
  // Token for one submission doesn't work for another.
  const other = w.ctx.startSubmission(form());
  let crossed = false; try { w.ctx.finishSubmission(victim.submissionId, 'direct', other.finishToken); crossed = true; } catch (e) {}
  check(!crossed, "one submission's token can't finish another"); }

// 6. Own "Incomplete" submission: repeated finishes can't spam the owner.
{ const w = world(LIVE); globalThis.__cache = {};
  const s = w.ctx.startSubmission(form());
  for (let i = 0; i < 5; i++) w.ctx.finishSubmission(s.submissionId, 'direct', s.finishToken);
  check(w.log.mails.length === 1, '5 finishes on an Incomplete upload -> only 1 owner email (was 5 before)'); }

// 7. What PAUSED does (owner sets the Script property).
{ const w = world(LIVE); globalThis.__cache = {};
  const inflight = w.ctx.startSubmission(form());            // started before the pause
  w.props.PAUSED = 'yes';
  const cfg = w.ctx.publicConfig_();
  check(cfg.accepting === false, 'PAUSED=yes: newly loaded pages show "Uploads are paused"');
  const drive0 = w.log.drive, rows0 = w.log.rows.length;
  let msg = ''; try { w.ctx.startSubmission(form()); } catch (e) { msg = e.message; }
  check(/paused/i.test(msg) && w.log.drive === drive0 && w.log.rows.length === rows0, 'PAUSED=yes: new sends refused before any folder, row or byte reservation');
  const st = w.ctx.uploadStatus(inflight.uploads[0].uploadId);
  const r = sendAll(w.ctx, inflight.uploads[0], 1000);
  const f = w.ctx.finishSubmission(inflight.submissionId, 'relay', inflight.finishToken);
  check(st.done === false && r.done === true && f.status === 'Complete', 'PAUSED=yes: an upload already in progress still finishes');
  for (const v of ['no', 'false', '']) { w.props.PAUSED = v; check(w.ctx.publicConfig_().accepting === true, `PAUSED="${v}" -> open`); }
  delete w.props.PAUSED; check(w.ctx.publicConfig_().accepting === true, 'PAUSED deleted -> open'); }

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
