// Isolated quota tests: Code.gs against in-memory fakes with a controllable clock.
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'Code.gs'), 'utf8');
const GB = 1024 ** 3, MB = 1024 ** 2, MIN = 60000;
let failures = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++; };

function world(opts = {}) {
  const props = { FOLDER_ID: 'LIVE_FOLDER', SHEET_ID: 'LIVE_SHEET', OWNER_EMAIL: 'owner@example.com', RELEASES_LOGGED: '2026-10-31-v3' };
  const cache = {};
  const log = { drive: 0, mails: [], rows: [['Started']], sessions: {}, folders: {}, fetches: 0, failSessionAt: opts.failSessionAt || 0, made: 0 };
  let clock = Date.UTC(2026, 10, 1, 18, 0); let n = 0;
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } }
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, JSON, Object, Number, String, Math, Error, Array, Buffer, Date: FakeDate,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      setProperties: (o) => Object.entries(o).forEach(([k, v]) => { props[k] = String(v); }), deleteProperty: (k) => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'UTC', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: {
      formatDate: (d, tz, f) => { const iso = new RealDate(d.getTime()).toISOString(); return f === 'yyyy-MM-dd' ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' '); },
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', k).update(v).digest()],
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
    },
    CacheService: { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null, remove: (k) => { delete cache[k]; } }) },
    ScriptApp: { getOAuthToken: () => 't' },
    Drive: { Files: {
      create: (m) => { log.drive++; const id = 'ID' + (++n); if (m.mimeType && m.mimeType.endsWith('folder')) log.folders[id] = []; return { id }; },
      get: () => ({ id: 'x', trashed: false }),
      list: (o) => ({ files: log.folders[o.q.match(/'([^']+)'/)[1]] || [] }),
    } },
    Sheets: { Spreadsheets: { Values: {
      append: (v, id, r) => { if (r.startsWith('Submissions')) log.rows.push(v.values[0].slice()); },
      update: (v, id, r) => { const m = r.match(/A(\d+):/); if (m) log.rows[Number(m[1]) - 1] = v.values[0].slice(); },
      get: (id, r) => (r.endsWith('B:B') ? { values: log.rows.map((x) => [x[1]]) } : { values: [log.rows[Number(r.match(/A(\d+):/)[1]) - 1].slice()] }),
    } } },
    UrlFetchApp: { fetch: (url, opt) => {
      log.fetches++;
      if (url.startsWith('https://www.googleapis.com/upload')) {
        if (log.failSessionAt && JSON.parse(opt.payload).name.startsWith(String(log.failSessionAt).padStart(2, '0') + ' ')) return { getResponseCode: () => 500, getAllHeaders: () => ({}), getContentText: () => 'boom' };
        const p = JSON.parse(opt.payload); const uri = 'https://up.example/s' + (++n);
        log.sessions[uri] = { parent: p.parents[0], name: p.name, size: Number(opt.headers['X-Upload-Content-Length']), got: 0, dead: false, done: false };
        return { getResponseCode: () => 200, getAllHeaders: () => ({ Location: uri }), getContentText: () => '' };
      }
      const s = log.sessions[url];
      const resp = (code, h = {}) => ({ getResponseCode: () => code, getAllHeaders: () => h, getContentText: () => '' });
      if (opt.method === 'delete') { if (opts.deleteWorks !== false && !s.done) s.dead = true; return resp(opts.deleteWorks !== false ? 499 : 405); }
      if (s.dead) return resp(499);
      if (s.done) return resp(200);
      return resp(308, s.got ? { Range: 'bytes=0-' + (s.got - 1) } : {});
    } },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: (m) => log.mails.push(m.subject) },
  };
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  const upload = (uri, bytes) => { const s = log.sessions[uri]; if (s.dead || s.done) return false; s.got = Math.min(s.size, s.got + bytes);
    if (s.got >= s.size) { s.done = true; log.folders[s.parent].push({ id: 'f', name: s.name, size: String(s.size) }); } return true; };
  const counters = () => ({ day: Number(props[Object.keys(props).find((k) => k.startsWith('BYTES_'))] || 0),
    hour: Object.values(JSON.parse(props.RECENT_BYTES || '{}')).reduce((a, b) => a + b, 0),
    starts: Number(props[Object.keys(props).find((k) => k.startsWith('STARTS_'))] || 0),
    pending: JSON.parse(props.PENDING || '[]').length });
  const start = (sizes, extra) => ctx.startSubmission(Object.assign({ agreedRelease: true, confirmedAdult: true, releaseVersion: '2026-10-31-v3',
    origin: 'https://n-abc-script.googleusercontent.com', files: sizes.map((sz, i) => ({ name: `v${i}.mov`, size: sz, type: 'video/quicktime' })) }, extra));
  const uris = (sub) => sub.uploads.map((u) => u.sessionUri);
  return { ctx, props, log, upload, counters, start, uris, tick: (ms) => { clock += ms; }, setConfig: (k, v) => vm.runInContext(`CONFIG.${k} = ${JSON.stringify(v)}`, ctx) };
}
const settle = (w) => w.start([1 * MB]); // any new send triggers the stall sweep

// A. Abandoned send, Drive honors cancel: space comes back only after the stall time.
{ const w = world();
  const a = w.start([2 * GB, 2 * GB, 2 * GB]);
  check(w.counters().hour === 6 * GB && w.counters().pending === 1, 'A: 6 GB reserved and listed as pending');
  w.tick(10 * MIN); settle(w);
  check(w.counters().hour === 6 * GB + MB, 'A: at 10 min (under the 15 min stall time) nothing is handed back');
  w.tick(6 * MIN); settle(w);
  check(w.counters().hour === 2 * MB && w.counters().day === 2 * MB, 'A: after 16 min idle: links cancelled, 6 GB handed back (hour and day)');
  check(w.uris(a).every((u) => w.log.sessions[u].dead) && !w.upload(w.uris(a)[0], MB), 'A: the cancelled links refuse more data'); }

// B. Drive ignores cancel: nothing is handed back while the link still accepts data.
{ const w = world({ deleteWorks: false });
  const a = w.start([2 * GB]); w.tick(16 * MIN); settle(w);
  check(w.counters().hour === 2 * GB + MB, 'B: cancel not confirmed -> the 2 GB stays reserved');
  check(w.upload(w.uris(a)[0], MB), 'B: (that link really can still take data, so keeping it reserved is right)'); }

// C. A slow but moving upload is never cancelled; it's only cancelled once it stops.
{ const w = world();
  const a = w.start([100 * MB]); const u = w.uris(a)[0];
  for (let i = 0; i < 4; i++) { w.tick(16 * MIN); w.upload(u, 10 * MB); settle(w); }
  check(!w.log.sessions[u].dead && w.counters().pending >= 1, 'C: a slow upload still sending after 64 min is left alone');
  w.tick(16 * MIN); settle(w);
  check(w.log.sessions[u].dead, 'C: once it sends nothing for 16 min it is cancelled'); }

// D. Uploaded but the page never called finish: keeps its charge, leaves the pending list.
{ const w = world();
  const a = w.start([50 * MB]); w.upload(w.uris(a)[0], 50 * MB); w.tick(16 * MIN); settle(w);
  check(w.counters().hour === 50 * MB + MB && !JSON.parse(w.props.PENDING).some((e) => e.s === a.submissionId), 'D: finished upload keeps its 50 MB charge and is settled'); }

// E. Finish with one of two videos missing: only the missing one is cancelled and handed back.
{ const w = world();
  const a = w.start([30 * MB, 70 * MB]); w.upload(w.uris(a)[0], 30 * MB);
  const r = w.ctx.finishSubmission(a.submissionId, 'direct', a.finishToken);
  check(r.status === 'Incomplete' && w.counters().hour === 30 * MB, 'E: Incomplete finish -> missing 70 MB handed back, 30 MB kept');
  check(w.log.sessions[w.uris(a)[1]].dead && w.counters().pending === 0, 'E: the missing video\'s link is closed; nothing left pending'); }

// F. Normal complete send: no refund, no extra Drive checks, nothing left pending.
{ const w = world();
  const a = w.start([40 * MB, 60 * MB]); w.uris(a).forEach((u, i) => w.upload(u, [40, 60][i] * MB));
  const before = w.log.fetches;
  const r = w.ctx.finishSubmission(a.submissionId, 'direct', a.finishToken);
  check(r.status === 'Complete' && w.counters().hour === 100 * MB && w.counters().pending === 0 && w.log.fetches === before, 'F: Complete -> keeps 100 MB, nothing pending, no extra Drive calls'); }

// G. startSubmission fails on the 2nd upload link: the 1st is cancelled and everything handed back.
{ const w = world({ failSessionAt: 2 });
  let err = ''; try { w.start([1 * GB, 1 * GB, 1 * GB]); } catch (e) { err = e.message; }
  const firstUri = Object.keys(w.log.sessions)[0];
  check(/couldn’t start/.test(err) && w.counters().hour === 0 && w.counters().day === 0, 'G: failed start -> all 3 GB handed back');
  check(w.log.sessions[firstUri].dead && w.counters().pending === 0, 'G: the one link that was made is closed, nothing pending'); }

// H. Count limits stop floods of tiny sends before any folder, link or row is made.
{ const w = world(); w.setConfig('MAX_SENDS_PER_HOUR', 5);
  for (let i = 0; i < 5; i++) w.start([1000]);
  const drive = w.log.drive, rows = w.log.rows.length; let err = '';
  try { w.start([1000]); } catch (e) { err = e.message; }
  check(/oversaturated right now/.test(err) && w.log.drive === drive && w.log.rows.length === rows, 'H: 6th send in an hour refused, before any folder or row');
  w.tick(61 * MIN); let ok = true; try { w.start([1000]); } catch (e) { ok = false; }
  check(ok, 'H: an hour later sends are accepted again'); }
{ const w = world(); w.setConfig('MAX_SENDS_PER_DAY', 3);
  for (let i = 0; i < 3; i++) { w.start([1000]); w.tick(61 * MIN); }
  let err = ''; try { w.start([1000]); } catch (e) { err = e.message; }
  check(/oversaturated for tonight/.test(err), 'H: daily send count enforced'); }

// I. Per-send size cap, checked before anything is reserved.
{ const w = world(); let err = '';
  try { w.start([5 * GB, 5 * GB, 5 * GB, 5 * GB, 1 * GB]); } catch (e) { err = e.message; }
  check(/more than 20 GB/.test(err) && w.counters().hour === 0 && w.counters().starts === 0, 'I: 21 GB in one send refused, nothing reserved or counted'); }

// J. Many people uploading at once: all accepted, none cancelled while sending.
{ const w = world();
  const subs = []; for (let i = 0; i < 25; i++) subs.push(w.start([200 * MB]));
  for (let round = 0; round < 3; round++) { w.tick(16 * MIN); subs.forEach((s) => w.upload(w.uris(s)[0], 50 * MB)); settle(w); }
  check(subs.every((s) => !w.log.sessions[w.uris(s)[0]].dead), 'J: 25 concurrent uploads, all still sending -> none cancelled');
  subs.forEach((s) => { w.upload(w.uris(s)[0], 200 * MB); w.ctx.finishSubmission(s.submissionId, 'direct', s.finishToken); });
  check(w.counters().day === 25 * 200 * MB + 3 * MB, 'J: daily total = exactly what was sent'); }

// K. Refunds only reach windows that are still open.
{ const w = world();
  w.start([1 * GB]); w.tick(70 * MIN); settle(w);
  check(w.counters().hour === MB && w.counters().day === MB + 0, 'K: refund after the hour has passed only lowers the daily total');
  const w2 = world(); w2.start([1 * GB]); w2.tick(24 * 60 * MIN); settle(w2);
  check(w2.counters().day === MB, "K: next day: yesterday's send is simply forgotten (new day starts fresh)"); }

// L. A finish and a sweep on the same send can't both hand back its space.
{ const w = world();
  const a = w.start([1 * GB, 1 * GB]); w.tick(16 * MIN);
  w.ctx.finishSubmission(a.submissionId, 'direct', a.finishToken); settle(w);
  w.ctx.settlePending_(a.submissionId, 'sweep');
  check(w.counters().day === MB && w.counters().hour === MB, 'L: refunded once only (2 GB), never twice'); }

// M. Pending list stays bounded (Script property size).
{ const w = world(); for (let i = 0; i < 80; i++) w.start([1000]);
  check(w.counters().pending <= 60 && w.props.PENDING.length < 9000, `M: pending list capped at 60 entries (${w.props.PENDING.length} bytes)`); }

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
