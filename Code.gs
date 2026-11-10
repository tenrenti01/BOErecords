/******************************************************************
 *  BOE RECORDS MANAGEMENT SYSTEM  ·  Code.gs  (server)
 *  The screen lives on GitHub Pages (index.html + config.js).
 *  This file lives in Google Apps Script, inside your Google Sheet, and
 *  answers the screen. It is the only file Apps Script needs.
 *
 *  FIRST TIME
 *   1. Make a new Google Sheet ▸ Extensions ▸ Apps Script.
 *   2. Delete everything in Code.gs and paste this whole file. Save.
 *   3. Pick  setupSystem  in the function list ▸ Run (approve the permissions).
 *      It makes the sheets, the BOE offices (OD down to the sections), one
 *      account per office, and a Drive folder for scans. The default
 *      passwords are printed in the execution log.
 *   4. Deploy ▸ New deployment ▸ Web app
 *        Execute as: Me      Who has access: Anyone
 *      Copy the Web app URL (ends in /exec) and paste it into config.js
 *      on GitHub.
 *   After any change to this file: Deploy ▸ Manage deployments ▸ Edit ▸
 *   Version: New version ▸ Deploy (the /exec link stays the same).
 *
 *  HOW A DOCUMENT MOVES
 *   1. OD (or the Administrative Staff) logs the document. It gets the next
 *      plain tracking number (1, 2, 3 …) and starts "On hand" there.
 *   2. The office sends it to one or more offices, at any level.
 *      • Incoming letters and memos / issuances land in the receiver's Inbox
 *        and wait for ACCEPT or RETURN.
 *      • Outgoing letters are already the office's own act, so they are
 *        delivered straight to the receiver's "On hand".
 *   3. From "On hand" an office FORWARDS it again (up or down the hierarchy)
 *      or marks it DONE. Every step is time-stamped with office and person.
 *   4. Higher offices see what is waiting in the offices under them.
 *
 *  HEAVY TRAFFIC
 *   Every save takes a turn (script lock). If it can't get a turn in 20 s the
 *   page waits and retries by itself. Each save carries an ID, so a retry
 *   never makes a duplicate.
 ******************************************************************/

const CFG = {
  SPREADSHEET_ID: '',          // leave blank when this script is attached to the Google Sheet
  APP_NAME: 'BOE Records Management System',
  TZ: 'Asia/Manila',
  MAX_FILE_MB: 15,
  LOCK_WAIT_MS: 20000,         // how long a save waits for its turn before the page retries
  OP_MEMORY_SEC: 21600,        // finished saves are remembered 6 h, so a retry never duplicates
  SESSION_TOKENS: 5            // sign-ins kept per account (office accounts are shared by staff)
};

const SH = { OFF: 'Offices', USERS: 'Users', REC: 'Records', MOV: 'Movements', LOG: 'Logs', SET: 'Settings' };

const COLS = {
  Offices:   ['Code', 'Office Name', 'Level', 'Parent', 'Head', 'Order', 'Active'],
  Users:     ['Username', 'Password', 'Full Name', 'Designation', 'Office', 'Role', 'Active', 'Session Token', 'Last Login'],
  Records:   ['TrackNo', 'Category', 'DocType', 'Subject', 'FromOffice', 'FromPerson', 'ToParty', 'RefNo', 'DocDate', 'Priority',
              'ActionRequired', 'DueDate', 'Pages', 'Remarks', 'FileId', 'FileName', 'FileMime', 'OriginOffice',
              'CreatedAt', 'CreatedBy', 'CreatedByName', 'UpdatedAt', 'OpId'],
  Movements: ['Id', 'TrackNo', 'ParentId', 'FromOffice', 'ToOffice', 'Purpose', 'Note', 'SentAt', 'SentBy', 'SentByName',
              'Status', 'RespondedAt', 'RespondedBy', 'RespondedByName', 'ResponseNote', 'Hold', 'HoldAt', 'HoldBy', 'HoldNote'],
  Logs:      ['Timestamp', 'TrackNo', 'Office', 'Username', 'Name', 'Action', 'Details', 'OpId'],
  Settings:  ['Key', 'Value', 'Notes']
};

// Columns kept as plain text so Sheets never turns them into dates or numbers.
const TEXT_COLS = {
  Offices: ['Code', 'Parent'],
  Users: ['Username', 'Password', 'Office'],
  Records: ['DocType', 'Subject', 'FromOffice', 'FromPerson', 'FromParty', 'ToParty', 'RefNo', 'DocDate', 'DueDate', 'ActionRequired', 'Remarks', 'OriginOffice'],
  Movements: ['Id', 'ParentId', 'Purpose', 'Note', 'ResponseNote', 'HoldNote'],
  Settings: ['Value']
};
const TIME_COLS = {
  Users: ['Last Login'], Records: ['CreatedAt', 'UpdatedAt'], Logs: ['Timestamp'],
  Movements: ['SentAt', 'RespondedAt', 'HoldAt']
};

const CATS = { INCOMING: 'Incoming', OUTGOING: 'Outgoing', ISSUANCE: 'Memo / Issuance' };
const DOC_TYPES = ['Letter', 'Memorandum', 'Department Order', 'Special Order', 'Office Order', 'Endorsement',
  'Report', 'Request', 'Invitation', 'Certification', 'Contract / Agreement', 'Others'];
const PURPOSES = ['For appropriate action', 'For information', 'For signature', 'For initials', 'For comment / recommendation',
  'For compliance', 'For review', 'For file'];
const PRIORITIES = ['Normal', 'Urgent', 'Rush'];
const LEVELS = ['Office', 'Staff', 'Division', 'Section', 'Unit'];

/* BOE offices, from the BOE 2026 organizational chart.
   Code, Office Name, Level, Parent, Head, Order.
   Add units under any section later in the Offices sheet (Level = Unit, Parent = section code). */
const SEED_OFFICES = [
  ['OD',    'Office of the Director',                         'Office',   '',     'Toribio Noel L. Ilao, Director IV',                1],
  ['OAD',   'Office of the Assistant Director',               'Office',   'OD',   'Hugh Van Erik Q. Tolentino, Director III',         2],
  ['ADMIN', 'Administrative Staff',                           'Staff',    'OD',   'Leonisa M. Dela Cruz, Administrative Officer IV',  3],
  ['EPD',   'Equipment Planning Division',                    'Division', 'OAD',  'Engr. Wilfredo Arthur C. Delizo, Engineer V',      10],
  ['PPS',   'Planning and Programming Section',               'Section',  'EPD',  '',                                                 11],
  ['UCAS',  'Utilization and Cost Analysis Section',          'Section',  'EPD',  '',                                                 12],
  ['EOMD',  'Equipment Operation and Maintenance Division',   'Division', 'OAD',  'Engr. Virgilio G. Rañoa, Engineer V',              20],
  ['EDOS',  'Equipment Deployment and Operation Section',     'Section',  'EOMD', '',                                                 21],
  ['EMMS',  'Equipment Maintenance and Management Section',   'Section',  'EOMD', '',                                                 22],
  ['FED',   'Floating Equipment Division',                    'Division', 'OAD',  'Engr. Francis L. Nuñez, OIC',                      30],
  ['DOSSS', 'Dredging Operations and Support Services Section', 'Section', 'FED', '',                                                 31],
  ['MDSS',  'Maintenance and Dry-Docking Services Section',   'Section',  'FED',  '',                                                 32],
  ['PSS',   'Planning and Surveying Section',                 'Section',  'FED',  '',                                                 33]
];

const DEFAULT_SETTINGS = [
  ['REPUBLIC', 'Republic of the Philippines', 'Routing slip header, line 1'],
  ['AGENCY', 'DEPARTMENT OF PUBLIC WORKS AND HIGHWAYS', 'Routing slip header, line 2'],
  ['BUREAU', 'BUREAU OF EQUIPMENT', 'Routing slip header, line 3'],
  ['ADDRESS', '2nd Street, Port Area, Manila', 'Routing slip header, line 4'],
  ['LOGO_URL', 'https://lh3.googleusercontent.com/d/15r0-MS1qhh_cizTu42-x8KjHpsMvKzmu', 'DPWH logo'],
  ['FILES_FOLDER_ID', '', 'Google Drive folder for scans (folder link or ID). setupSystem() makes one if blank.'],
  ['LOG_OFFICES', 'OD,ADMIN', 'Offices that log new records and give tracking numbers. Office codes separated by commas, or ALL.'],
  ['SEE_ALL_OFFICES', 'OD,OAD,ADMIN', 'Offices that can open every record. Others see what passed through them and the offices under them.'],
  ['START_NUMBER', '1', 'Lowest tracking number to give. Raise it to continue a paper logbook.'],
  ['AUTO_FIND_SCANS', 'TRUE', 'Attach a scan automatically when a file in the scans folder starts with the tracking number, e.g. "25 - Letter.pdf".'],
  ['POLL_SECONDS', '10', 'How often each screen checks for new documents.']
];

// Bump this when COLS changes: the server then adds the new columns to the sheets by itself.
const SCHEMA = '2026-11-09b';

const FIELD_LABELS = {
  Category: 'Category', DocType: 'Type', Subject: 'Subject', FromOffice: 'From (office)', FromPerson: 'From (person)', ToParty: 'To', RefNo: 'Ref. no.',
  DocDate: 'Document date', Priority: 'Priority', ActionRequired: 'Action required', DueDate: 'Due date',
  Pages: 'Pages', Remarks: 'Remarks'
};

/* ================================================================ WEB APP (answers the GitHub page)
   The page sends  { fn: 'apiBoard', args: [...] }  as a plain-text POST
   (no custom headers, so the browser allows it from GitHub Pages) and gets
   { ok: true, result } or { ok: false, error } back as JSON. */
function apiList_() {
  return {
    apiBoot: apiBoot, apiLogin: apiLogin, apiLogout: apiLogout, apiChangePassword: apiChangePassword,
    apiRev: apiRev, apiBoard: apiBoard, apiRecord: apiRecord, apiSearch: apiSearch, apiFindScans: apiFindScans,
    apiUpload: apiUpload, apiPdf: apiPdf, apiAct: apiAct, apiAdmin: apiAdmin, apiAdminSave: apiAdminSave,
    apiSuggest: apiSuggest, apiCheckNo: apiCheckNo
  };
}
function callApi_(fn, args) {
  const f = apiList_()[s_(fn)];
  if (!f) return { ok: false, error: 'Unknown request "' + s_(fn) + '".' };
  try { upgrade_(); return { ok: true, result: f.apply(null, Array.isArray(args) ? args : []) }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (x) { return json_({ ok: false, error: 'The request could not be read.' }); }
  return json_(callApi_(req.fn, req.args));
}

/** Opening the /exec link in a browser shows this check message. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.fn) {
    let args = [];
    try { args = JSON.parse(p.args || '[]'); } catch (x) { /* no arguments */ }
    return json_(callApi_(p.fn, args));
  }
  let ready = true;
  try { table_(SH.OFF); } catch (x) { ready = false; }
  return json_({ ok: true, app: CFG.APP_NAME, sheetsReady: ready,
    message: ready ? 'The BOE RMS server is running. Paste this page\'s link into config.js on your GitHub site.'
                   : 'The server is running, but the sheets are not set up yet. Run setupSystem() once in the Apps Script editor.' });
}

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('BOE RMS')
      .addItem('Set up / repair sheets', 'setupSystem')
      .addToUi();
  } catch (e) { /* not opened from the sheet */ }
}

/* ================================================================ SMALL HELPERS */
let SEQ_ = 0;
let SHEET_TZ_ = '';
function ss_() { return CFG.SPREADSHEET_ID ? SpreadsheetApp.openById(CFG.SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet(); }
function now_() { return new Date(); }
function s_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function n_(v) { const x = Number(v); return isFinite(x) ? x : 0; }
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function ms_(v) {
  if (isDate_(v)) return v.getTime();
  if (v === '' || v === null || v === undefined) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.getTime();
}
function truthy_(v) { return v === true || /^(true|yes|y|1|active)$/i.test(s_(v)); }
function active_(v) { return v === '' || v === null || v === undefined || truthy_(v); }
function list_(v) { return s_(v).split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean); }
function uid_(p) { return p + Date.now().toString(36).toUpperCase() + (SEQ_++).toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(); }
function fail_(msg) { throw new Error(msg); }
function pick_(o, k, d) { return o && o[k] !== undefined && o[k] !== null ? o[k] : d; }
function sheetTz_() {
  if (!SHEET_TZ_) { try { SHEET_TZ_ = ss_().getSpreadsheetTimeZone() || CFG.TZ; } catch (e) { SHEET_TZ_ = CFG.TZ; } }
  return SHEET_TZ_;
}
function today_() { return Utilities.formatDate(now_(), CFG.TZ, 'yyyy-MM-dd'); }
function dateIn_(v) {
  v = s_(v);
  if (!v) return '';
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd');
}
function dateOut_(v) {
  if (isDate_(v)) return Utilities.formatDate(v, sheetTz_(), 'yyyy-MM-dd');
  const m = s_(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : s_(v);
}
function idFromLink_(v) {
  v = s_(v);
  if (!v) return '';
  const m = v.match(/\/d\/([-\w]{20,})/) || v.match(/\/folders\/([-\w]{20,})/) || v.match(/[?&]id=([-\w]{20,})/);
  if (m) return m[1];
  return /^[-\w]{20,}$/.test(v) ? v : '';
}

/* ================================================================ SHEET ACCESS */
function table_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) fail_('Missing sheet "' + name + '". Run setupSystem() once from the Apps Script editor.');
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  const vals = lastRow ? sh.getRange(1, 1, lastRow, Math.max(lastCol, 1)).getValues() : [[]];
  const head = (vals.shift() || []).map(h => s_(h));
  const rows = [];
  vals.forEach((r, i) => {
    if (r.every(x => x === '' || x === null)) return;
    const o = { _r: i + 2 };
    head.forEach((h, j) => { if (h) o[h] = r[j]; });
    rows.push(o);
  });
  return { name: name, sh: sh, head: head, rows: rows };
}
function rowVals_(t, o) { return t.head.map(h => (h && o[h] !== undefined && o[h] !== null) ? o[h] : ''); }
function save_(t, o) { t.sh.getRange(o._r, 1, 1, t.head.length).setValues([rowVals_(t, o)]); }
function add_(t, list) {
  if (!list.length) return;
  const start = Math.max(t.sh.getLastRow(), 1) + 1;
  t.sh.getRange(start, 1, list.length, t.head.length).setValues(list.map(o => rowVals_(t, o)));
  list.forEach((o, i) => { o._r = start + i; t.rows.push(o); });
}

/** After a new Code.gs adds columns, the first request adds them to the existing sheets (no need to run setupSystem again). */
function upgrade_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA') === SCHEMA) return;
  const ss = ss_();
  if (!ss.getSheetByName(SH.OFF)) return;                 // not set up yet: setupSystem() makes everything
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG.LOCK_WAIT_MS)) fail_('BUSY: The system is updating its sheets. Retrying…');
  try {
    if (props.getProperty('SCHEMA') === SCHEMA) return;
    migrateFrom_(ss);
    Object.keys(COLS).forEach(name => { if (ss.getSheetByName(name)) ensureSheet_(ss, name, COLS[name]); });
    SpreadsheetApp.flush();
    props.setProperty('SCHEMA', SCHEMA);
  } finally { lock.releaseLock(); }
}

/** The old single "FromParty" column becomes "FromOffice", with a new "FromPerson" column right after it. */
function migrateFrom_(ss) {
  const sh = ss.getSheetByName(SH.REC);
  if (!sh || !sh.getLastColumn()) return;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(s_);
  const i = head.indexOf('FromParty');
  if (i < 0 || head.indexOf('FromOffice') >= 0) return;
  sh.getRange(1, i + 1).setValue('FromOffice');
  if (head.indexOf('FromPerson') < 0) { sh.insertColumnAfter(i + 1); sh.getRange(1, i + 2).setValue('FromPerson'); }
}

function settings_() {
  const out = {};
  DEFAULT_SETTINGS.forEach(d => { out[d[0]] = d[1]; });
  try { table_(SH.SET).rows.forEach(r => { const k = s_(r.Key).toUpperCase(); if (k) out[k] = s_(r.Value); }); } catch (e) { /* not set up yet */ }
  return out;
}
function publicSet_(set) {
  const out = {};
  ['REPUBLIC', 'AGENCY', 'BUREAU', 'ADDRESS', 'LOGO_URL', 'LOG_OFFICES', 'SEE_ALL_OFFICES', 'POLL_SECONDS'].forEach(k => { out[k] = set[k]; });
  return out;
}

/* ================================================================ OFFICES (HIERARCHY) */
function org_() {
  const list = table_(SH.OFF).rows.filter(r => s_(r.Code)).map(r => ({
    code: s_(r.Code).toUpperCase(),
    name: s_(r['Office Name']) || s_(r.Code).toUpperCase(),
    level: s_(r.Level) || 'Unit',
    parent: s_(r.Parent).toUpperCase(),
    head: s_(r.Head),
    order: n_(r.Order),
    active: active_(r.Active)
  }));
  const map = {};
  list.forEach(o => { map[o.code] = o; });
  list.forEach(o => { if (o.parent === o.code || (o.parent && !map[o.parent])) o.parent = ''; });
  list.forEach(o => {                                   // a loop in the Parent column is cut at that office
    const seen = {};
    let p = o;
    while (p && p.parent) {
      if (seen[p.code]) { o.parent = ''; break; }
      seen[p.code] = 1;
      p = map[p.parent];
    }
  });
  const kids = {};
  list.forEach(o => { (kids[o.parent] = kids[o.parent] || []).push(o.code); });
  Object.keys(kids).forEach(k => kids[k].sort((a, b) => (map[a].order - map[b].order) || a.localeCompare(b)));
  return { list: list, map: map, kids: kids };
}
/** The office and every office under it. */
function under_(org, code) {
  const out = new Set();
  const walk = c => { if (out.has(c)) return; out.add(c); (org.kids[c] || []).forEach(walk); };
  walk(code);
  return out;
}
/** Tree order with depth, for the screens. */
function orgOut_(org) {
  const out = [];
  const walk = (code, depth) => {
    const o = org.map[code];
    out.push({ code: o.code, name: o.name, level: o.level, parent: o.parent, head: o.head, order: o.order, active: o.active, depth: depth });
    (org.kids[code] || []).forEach(k => walk(k, depth + 1));
  };
  (org.kids[''] || []).forEach(k => walk(k, 0));
  return out;
}

/* ================================================================ ACCOUNTS */
function userOut_(u) {
  return {
    username: s_(u.Username).toLowerCase(),
    name: s_(u['Full Name']) || s_(u.Username),
    designation: s_(u.Designation),
    office: s_(u.Office).toUpperCase(),
    role: /admin/i.test(s_(u.Role)) ? 'Admin' : 'User'
  };
}
function hash_(pw, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}
function makePw_(pw) {
  const salt = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  return 'sha256$' + salt + '$' + hash_(pw, salt);
}
/** A password typed as plain text in the sheet by the admin also works, and is hashed on the next sign-in. */
function checkPw_(stored, pw) {
  stored = s_(stored);
  if (stored.indexOf('sha256$') === 0) { const p = stored.split('$'); return hash_(pw, p[1]) === p[2]; }
  return stored !== '' && stored === String(pw);
}
function seeAll_(user, set) { return user.role === 'Admin' || list_(set.SEE_ALL_OFFICES).indexOf(user.office) >= 0; }
function canLog_(user, set) {
  const l = list_(set.LOG_OFFICES);
  return user.role === 'Admin' || l.indexOf('ALL') >= 0 || l.indexOf(user.office) >= 0;
}

function auth_(token) {
  token = s_(token);
  if (!token) fail_('AUTH: Please sign in.');
  const cache = CacheService.getScriptCache();
  const hit = cache.get('tok:' + token);
  if (hit) return JSON.parse(hit);
  const u = table_(SH.USERS).rows.find(r => (' ' + s_(r['Session Token']) + ' ').indexOf(' ' + token + ' ') >= 0);
  if (!u || !active_(u.Active)) fail_('AUTH: Your sign-in has ended. Please sign in again.');
  const user = userOut_(u);
  cache.put('tok:' + token, JSON.stringify(user), 1800);
  return user;
}

function apiLogin(username, password) {
  username = s_(username).toLowerCase();
  password = String(password || '');
  if (!username || !password) fail_('Type your username and password.');
  return locked_(() => {
    const t = table_(SH.USERS);
    const u = t.rows.find(r => s_(r.Username).toLowerCase() === username);
    if (!u || !checkPw_(u.Password, password)) fail_('Wrong username or password.');
    if (!active_(u.Active)) fail_('This account is turned off. Please ask the system admin.');
    const user = userOut_(u);
    if (!org_().map[user.office]) fail_('This account has no valid office ("' + user.office + '"). Please ask the system admin.');
    if (s_(u.Password).indexOf('sha256$') !== 0) u.Password = makePw_(password);
    const token = Utilities.getUuid().replace(/-/g, '') + Math.random().toString(36).slice(2, 8);
    u['Session Token'] = [token].concat(s_(u['Session Token']).split(/\s+/).filter(Boolean)).slice(0, CFG.SESSION_TOKENS).join(' ');
    u['Last Login'] = now_();
    save_(t, u);
    log_([{ no: '', office: user.office, user: user, action: 'Signed in', details: '' }]);
    CacheService.getScriptCache().put('tok:' + token, JSON.stringify(user), 1800);
    return { token: token, user: user };
  });
}

function apiLogout(token) {
  token = s_(token);
  if (!token) return { ok: true };
  CacheService.getScriptCache().remove('tok:' + token);
  try {
    locked_(() => {
      const t = table_(SH.USERS);
      const u = t.rows.find(r => (' ' + s_(r['Session Token']) + ' ').indexOf(' ' + token + ' ') >= 0);
      if (u) { u['Session Token'] = s_(u['Session Token']).split(/\s+/).filter(x => x && x !== token).join(' '); save_(t, u); }
    });
  } catch (e) { /* signing out never fails */ }
  return { ok: true };
}

function apiChangePassword(token, oldPw, newPw) {
  const user = auth_(token);
  newPw = String(newPw || '');
  if (newPw.length < 6) fail_('Use at least 6 characters for the new password.');
  return locked_(() => {
    const t = table_(SH.USERS);
    const u = t.rows.find(r => s_(r.Username).toLowerCase() === user.username);
    if (!u || !checkPw_(u.Password, String(oldPw || ''))) fail_('Your current password is wrong.');
    u.Password = makePw_(newPw);
    save_(t, u);
    log_([{ no: '', office: user.office, user: user, action: 'Password changed', details: '' }]);
    return { ok: true };
  });
}

/* ================================================================ TURN-TAKING, REVISION, LOG */
function locked_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG.LOCK_WAIT_MS)) fail_('BUSY: Many offices are saving at once. Retrying…');
  try {
    const r = fn();
    SpreadsheetApp.flush();
    return r;
  } finally {
    lock.releaseLock();
  }
}
function bump_() { PropertiesService.getScriptProperties().setProperty('REV', String(Date.now()) + String(SEQ_++)); }
function rev_() { return PropertiesService.getScriptProperties().getProperty('REV') || '0'; }

/** Cheap check the screens call every few seconds: has anything changed? */
function apiRev() { return { rev: rev_() }; }

function log_(items, opId) {
  if (!items.length) return;
  const sh = ss_().getSheetByName(SH.LOG);
  if (!sh) return;
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(s_);
  const now = now_();
  const vals = items.map(it => {
    const o = { Timestamp: now, TrackNo: it.no || '', Office: it.office || it.user.office, Username: it.user.username,
      Name: it.user.name, Action: it.action, Details: it.details || '', OpId: opId || '' };
    return head.map(h => pick_(o, h, ''));
  });
  sh.getRange(Math.max(sh.getLastRow(), 1) + 1, 1, vals.length, head.length).setValues(vals);
}

/* ================================================================ READ: BOOT, BOARD, RECORD, SEARCH */
function apiBoot() {
  const set = settings_();
  const org = org_();
  const users = table_(SH.USERS).rows.filter(u => s_(u.Username) && active_(u.Active)).map(u => {
    const o = userOut_(u);
    return { username: o.username, name: o.name, designation: o.designation, office: o.office };
  });
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { /* not deployed yet */ }
  return {
    app: CFG.APP_NAME, set: publicSet_(set), org: orgOut_(org), users: users, url: url, maxMb: CFG.MAX_FILE_MB,
    lists: { cats: CATS, docTypes: DOC_TYPES, purposes: PURPOSES, priorities: PRIORITIES, levels: LEVELS }
  };
}

function recOut_(r) {
  return {
    no: n_(r.TrackNo), cat: s_(r.Category), type: s_(r.DocType), subject: s_(r.Subject),
    fromO: s_(r.FromOffice) || s_(r.FromParty), fromN: s_(r.FromPerson), fromP: fromText_(r),
    toP: s_(r.ToParty), ref: s_(r.RefNo), docDate: dateOut_(r.DocDate), prio: s_(r.Priority) || 'Normal',
    action: s_(r.ActionRequired), due: dateOut_(r.DueDate), pages: s_(r.Pages), remarks: s_(r.Remarks),
    fileId: s_(r.FileId), fileName: s_(r.FileName), fileMime: s_(r.FileMime), origin: s_(r.OriginOffice),
    createdAt: ms_(r.CreatedAt), createdBy: s_(r.CreatedByName) || s_(r.CreatedBy), updatedAt: ms_(r.UpdatedAt)
  };
}
/** "Office · Person" for lists, search and the routing slip. */
function fromText_(r) { return [s_(r.FromOffice) || s_(r.FromParty), s_(r.FromPerson)].filter(Boolean).join(' · '); }
function mvOut_(m) {
  return {
    id: s_(m.Id), no: n_(m.TrackNo), parent: s_(m.ParentId), from: s_(m.FromOffice), to: s_(m.ToOffice),
    purpose: s_(m.Purpose), note: s_(m.Note), sentAt: ms_(m.SentAt), sentBy: s_(m.SentByName) || s_(m.SentBy),
    status: s_(m.Status), respAt: ms_(m.RespondedAt), respBy: s_(m.RespondedByName) || s_(m.RespondedBy),
    respNote: s_(m.ResponseNote), hold: s_(m.Hold), holdAt: ms_(m.HoldAt), holdBy: s_(m.HoldBy), holdNote: s_(m.HoldNote)
  };
}
function live_(m) { return s_(m.Status) === 'PENDING' || s_(m.Hold) === 'HELD'; }

/** Everything one office's screen needs, in one trip. */
function apiBoard(token) {
  const user = auth_(token);
  const set = settings_();
  const org = org_();
  if (!org.map[user.office]) fail_('AUTH: Your office "' + user.office + '" is no longer in the Offices sheet.');
  const recs = table_(SH.REC).rows;
  const mov = table_(SH.MOV).rows;
  const me = user.office;
  const all = seeAll_(user, set);
  const mine = under_(org, me);
  const today = today_();
  const recMap = {};
  recs.forEach(r => { recMap[n_(r.TrackNo)] = r; });

  const L = { inbox: [], onhand: [], sent: [], done: [], units: [] };
  const counts = {};
  mov.forEach(m => {
    const to = s_(m.ToOffice), from = s_(m.FromOffice), st = s_(m.Status), hold = s_(m.Hold);
    const isLive = st === 'PENDING' || hold === 'HELD';
    if (isLive) {
      const k = counts[to] || (counts[to] = { p: 0, h: 0, late: 0 });
      if (st === 'PENDING') k.p++; else k.h++;
      const r = recMap[n_(m.TrackNo)];
      const due = r ? dateOut_(r.DueDate) : '';
      if (due && due < today) k.late++;
    }
    if (to === me) {
      if (st === 'PENDING') L.inbox.push(m);
      else if (hold === 'HELD') L.onhand.push(m);
      else if (hold === 'DONE') L.done.push(m);
    } else if (isLive && (all || mine.has(to))) {
      L.units.push(m);
    }
    if (from === me) L.sent.push(m);
  });
  const by = k => (a, b) => (ms_(b[k]) || 0) - (ms_(a[k]) || 0);
  L.inbox.sort(by('SentAt'));
  L.onhand.sort(by('HoldAt'));
  L.sent.sort(by('SentAt'));
  L.done.sort(by('HoldAt'));
  L.units.sort(by('SentAt'));
  L.sent = L.sent.slice(0, 300);
  L.done = L.done.slice(0, 300);
  L.units = L.units.slice(0, 600);

  const lists = {}, used = {};
  Object.keys(L).forEach(k => { lists[k] = L[k].map(m => { used[n_(m.TrackNo)] = 1; return mvOut_(m); }); });
  const records = {};
  Object.keys(used).forEach(no => { if (recMap[no]) records[no] = recOut_(recMap[no]); });

  const next = canLog_(user, set) ? nextNo_(recs, set) : '';
  return {
    rev: rev_(), now: Date.now(), today: today, me: user, seeAll: all, canLog: canLog_(user, set), next: next,
    set: publicSet_(set), org: orgOut_(org), lists: lists, records: records, counts: counts
  };
}

function canSee_(user, set, org, rec, mov) {
  if (seeAll_(user, set)) return true;
  const mine = under_(org, user.office);
  return mine.has(s_(rec.OriginOffice)) || mov.some(m => mine.has(s_(m.ToOffice)) || mine.has(s_(m.FromOffice)));
}

function logOut_(l) {
  return { at: ms_(l.Timestamp), office: s_(l.Office), name: s_(l.Name) || s_(l.Username), action: s_(l.Action), details: s_(l.Details) };
}
function logsFor_(no) {
  const sh = ss_().getSheetByName(SH.LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(s_);
  const col = head.indexOf('TrackNo') + 1;
  if (!col) return [];
  const hits = sh.getRange(2, col, sh.getLastRow() - 1, 1).createTextFinder(String(no)).matchEntireCell(true).findAll();
  return hits.map(rg => {
    const r = sh.getRange(rg.getRow(), 1, 1, head.length).getValues()[0];
    const o = {};
    head.forEach((h, i) => { o[h] = r[i]; });
    return logOut_(o);
  }).sort((a, b) => a.at - b.at);
}

function apiRecord(token, no) {
  const user = auth_(token);
  no = n_(no);
  const set = settings_();
  const org = org_();
  let rec = table_(SH.REC).rows.find(r => n_(r.TrackNo) === no);
  if (!rec) fail_('Record No. ' + no + ' was not found.');
  const mov = table_(SH.MOV).rows.filter(m => n_(m.TrackNo) === no);
  if (!canSee_(user, set, org, rec, mov)) fail_('No. ' + no + ' has not passed through your office or the offices under it.');

  let found = [];
  if (!s_(rec.FileId) && truthy_(set.AUTO_FIND_SCANS)) {
    found = findScans_(set, no);
    if (found.length === 1) {                          // exactly one match: attach it by itself
      const lock = LockService.getScriptLock();
      if (lock.tryLock(4000)) {
        try {
          const t = table_(SH.REC);
          const r = t.rows.find(x => n_(x.TrackNo) === no);
          if (r && !s_(r.FileId)) {
            share_(found[0].id);
            setFile_(r, found[0]);
            save_(t, r);
            log_([{ no: no, office: user.office, user: user, action: 'Scan found', details: found[0].name + ' (found in the scans folder)' }]);
            SpreadsheetApp.flush();
            bump_();
            rec = r;
            found = [];
          }
        } finally { lock.releaseLock(); }
      }
    }
  }
  const involved = mov.some(m => s_(m.ToOffice) === user.office || s_(m.FromOffice) === user.office) || s_(rec.OriginOffice) === user.office;
  return {
    rev: rev_(), rec: recOut_(rec), mov: mov.map(mvOut_).sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0)),
    logs: logsFor_(no), found: found,
    canEdit: user.role === 'Admin' || s_(rec.OriginOffice) === user.office,
    canAttach: user.role === 'Admin' || involved || seeAll_(user, set)
  };
}

function apiSearch(token, q, opt) {
  const user = auth_(token);
  opt = opt || {};
  const set = settings_();
  const org = org_();
  const all = seeAll_(user, set);
  const mine = under_(org, user.office);
  const recs = table_(SH.REC).rows;
  const byNo = {};
  table_(SH.MOV).rows.forEach(m => { (byNo[n_(m.TrackNo)] = byNo[n_(m.TrackNo)] || []).push(m); });
  q = s_(q).toLowerCase();
  const exact = q.match(/^#?\s*(\d+)$/);
  const words = q.split(/\s+/).filter(Boolean);
  const out = [];
  let matched = 0;
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    const no = n_(r.TrackNo);
    const ms = byNo[no] || [];
    if (!all && !(mine.has(s_(r.OriginOffice)) || ms.some(m => mine.has(s_(m.ToOffice)) || mine.has(s_(m.FromOffice))))) continue;
    if (opt.cat && s_(r.Category) !== opt.cat) continue;
    if (opt.office && !ms.some(m => s_(m.ToOffice) === opt.office || s_(m.FromOffice) === opt.office)) continue;
    const at = ms.filter(live_).map(m => ({ o: s_(m.ToOffice), p: s_(m.Status) === 'PENDING' }));
    const state = at.length ? 'ACTIVE' : (ms.some(m => s_(m.Hold) === 'DONE') ? 'DONE' : 'CLOSED');
    if (opt.state && opt.state !== state) continue;
    if (exact) { if (no !== Number(exact[1])) continue; }
    else if (words.length) {
      const hay = [r.Subject, r.FromOffice, r.FromPerson, r.FromParty, r.ToParty, r.RefNo, r.DocType, r.Remarks, r.OriginOffice].map(s_).join(' ').toLowerCase();
      if (!words.every(w => hay.indexOf(w) >= 0)) continue;
    }
    matched++;
    if (out.length < 400) out.push(Object.assign(recOut_(r), { at: at, state: state }));
  }
  return { rows: out, matched: matched, total: recs.length };
}

/* ================================================================ SCANS (GOOGLE DRIVE) */
function folder_(set, mustExist) {
  const id = idFromLink_(set.FILES_FOLDER_ID);
  if (id) {
    try { return DriveApp.getFolderById(id); }
    catch (e) { if (mustExist) fail_('The scans folder in Settings could not be opened. Check FILES_FOLDER_ID.'); return null; }
  }
  if (mustExist) fail_('No scans folder is set. Run setupSystem(), or put a folder link in Settings ▸ FILES_FOLDER_ID.');
  return null;
}
function share_(id) {
  try { DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* domain policy may forbid it */ }
}
function setFile_(r, f) { r.FileId = f.id; r.FileName = f.name || ''; r.FileMime = f.mime || ''; }

/** Files in the scans folder whose names start with the tracking number: "25.pdf", "25 - Letter.pdf", "0025_scan.jpg". */
function findScans_(set, no) {
  const folder = folder_(set, false);
  if (!folder || !no) return [];
  const re = new RegExp('^0*' + no + '(?![0-9])');
  const out = [];
  const take = q => {
    try {
      const it = folder.searchFiles(q);
      let k = 0;
      while (it.hasNext() && k++ < 200 && out.length < 8) {
        const f = it.next();
        if (re.test(f.getName()) && !out.some(x => x.id === f.getId())) {
          out.push({ id: f.getId(), name: f.getName(), mime: f.getMimeType(), at: ms_(f.getLastUpdated()) });
        }
      }
    } catch (e) { /* Drive search hiccup: show none */ }
  };
  take("title contains '" + no + "' and trashed = false");
  const padded = ('0000' + no).slice(-4);
  if (padded !== String(no)) take("title contains '" + padded + "' and trashed = false");
  return out;
}

function apiFindScans(token, no) {
  auth_(token);
  return { found: findScans_(settings_(), n_(no)) };
}

/** Upload a scan (no turn-taking needed: it only makes a Drive file). */
function apiUpload(token, f) {
  auth_(token);
  f = f || {};
  const cache = CacheService.getScriptCache();
  const key = f.opId ? 'up:' + s_(f.opId) : '';
  if (key) { const hit = cache.get(key); if (hit) return JSON.parse(hit); }
  const b64 = s_(f.b64);
  if (!b64) fail_('No file was received.');
  if (b64.length * 0.75 > CFG.MAX_FILE_MB * 1048576) fail_('The file is bigger than ' + CFG.MAX_FILE_MB + ' MB. Scan it at a lower quality, or split it.');
  const mime = s_(f.mime) || 'application/pdf';
  if (!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(mime)) fail_('Use a PDF, JPG or PNG file.');
  const folder = folder_(settings_(), true);
  const name = s_(f.name).replace(/[\\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 150) || 'scan';
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime, name));
  share_(file.getId());
  const out = { id: file.getId(), name: file.getName(), mime: mime };
  if (key) cache.put(key, JSON.stringify(out), CFG.OP_MEMORY_SEC);
  return out;
}

/** A4 routing slip as a PDF file (the page sends the slip's HTML). */
function apiPdf(token, html, name) {
  auth_(token);
  const blob = Utilities.newBlob(String(html || ''), 'text/html', 'slip.html').getAs('application/pdf');
  return { b64: Utilities.base64Encode(blob.getBytes()), name: s_(name) || 'Routing slip.pdf' };
}

/* ================================================================ WRITE: ONE DOOR FOR EVERY ACTION */
/**
 * op = { opId, type, ... }   type: CREATE, SEND, ACCEPT, RETURN, RECALL, DONE, REOPEN, EDIT, ATTACH
 * The page waits 5 seconds (Undo) before it calls this. Retries reuse the same opId.
 */
function apiAct(token, op) {
  const user = auth_(token);
  op = op || {};
  const type = s_(op.type).toUpperCase();
  const fn = ACT[type];
  if (!fn) fail_('Unknown action.');
  const opId = s_(op.opId);
  const cache = CacheService.getScriptCache();
  const seen = opId ? cache.get('op:' + opId) : null;
  if (seen) return JSON.parse(seen);
  return locked_(() => {
    const again = opId ? cache.get('op:' + opId) : null;
    if (again) return JSON.parse(again);
    const c = ctx_(user);
    const res = fn(c, op) || {};
    log_(c.logs, opId);
    bump_();
    const out = Object.assign({ ok: true, type: type }, res);
    if (opId) cache.put('op:' + opId, JSON.stringify(out), CFG.OP_MEMORY_SEC);
    return out;
  });
}

function ctx_(user) {
  const c = { user: user, office: user.office, isAdmin: user.role === 'Admin', now: now_(), set: settings_(), org: org_(),
    rec: table_(SH.REC), mov: table_(SH.MOV), logs: [], recByNo: {} };
  if (!c.org.map[c.office]) fail_('AUTH: Your office "' + c.office + '" is no longer in the Offices sheet.');
  c.rec.rows.forEach(r => { c.recByNo[n_(r.TrackNo)] = r; });
  return c;
}
function note_(c, no, action, details) { c.logs.push({ no: no, office: c.office, user: c.user, action: action, details: details }); }
function rec_(c, no) { const r = c.recByNo[n_(no)]; if (!r) fail_('Record No. ' + n_(no) + ' was not found.'); return r; }
function mv_(c, id) { const m = c.mov.rows.find(r => s_(r.Id) === s_(id)); if (!m) fail_('That routing entry was not found. The screen may be out of date.'); return m; }
function touch_(c, no) { const r = c.recByNo[n_(no)]; if (r) { r.UpdatedAt = c.now; save_(c.rec, r); } }
function involved_(c, no) {
  const r = c.recByNo[n_(no)];
  if (r && s_(r.OriginOffice) === c.office) return true;
  return c.mov.rows.some(m => n_(m.TrackNo) === n_(no) && (s_(m.ToOffice) === c.office || s_(m.FromOffice) === c.office));
}

function fields_(raw, isNew) {
  raw = raw || {};
  const f = {};
  if (isNew || raw.Category !== undefined) {
    const cat = s_(raw.Category).toUpperCase();
    if (!CATS[cat]) fail_('Choose a category: Incoming, Outgoing, or Memo / Issuance.');
    f.Category = cat;
  }
  const txt = (k, max) => { if (raw[k] !== undefined) f[k] = s_(raw[k]).slice(0, max); };
  if (raw.FromOffice === undefined && raw.FromParty !== undefined) raw = Object.assign({}, raw, { FromOffice: raw.FromParty });
  txt('DocType', 60); txt('Subject', 600); txt('FromOffice', 200); txt('FromPerson', 200); txt('ToParty', 300); txt('RefNo', 120);
  txt('Remarks', 1500);
  if (raw.ActionRequired !== undefined) {                 // several can be ticked: "For information; For file"
    const parts = [];
    [].concat(raw.ActionRequired).join(';').split(';').map(x => s_(x)).forEach(x => { if (x && parts.indexOf(x) < 0) parts.push(x); });
    f.ActionRequired = parts.join('; ').slice(0, 400);
  }
  if (raw.Priority !== undefined) f.Priority = PRIORITIES.indexOf(s_(raw.Priority)) >= 0 ? s_(raw.Priority) : 'Normal';
  if (raw.Pages !== undefined) f.Pages = s_(raw.Pages) === '' ? '' : Math.max(0, Math.floor(n_(raw.Pages)));
  if (raw.DocDate !== undefined) f.DocDate = dateIn_(raw.DocDate);
  if (raw.DueDate !== undefined) f.DueDate = dateIn_(raw.DueDate);
  if (isNew && !f.Subject) fail_('Type the subject.');
  if (!isNew && raw.Subject !== undefined && !f.Subject) fail_('The subject cannot be blank.');
  return f;
}

/** Puts one copy of the document in each office's Inbox (or straight On hand, for outgoing). */
function send_(c, row, opt) {
  const no = n_(row.TrackNo);
  const rec = rec_(c, no);
  const want = [];
  (opt.to || []).forEach(x => { x = s_(x).toUpperCase(); if (x && want.indexOf(x) < 0) want.push(x); });
  const bad = want.filter(x => !c.org.map[x] || !c.org.map[x].active);
  if (bad.length) fail_('Unknown or inactive office: ' + bad.join(', '));
  const to = want.filter(x => x !== c.office);
  if (!to.length) fail_('Pick at least one other office.');
  const busy = {};
  c.mov.rows.forEach(m => { if (n_(m.TrackNo) === no && live_(m)) busy[s_(m.ToOffice)] = 1; });
  const dup = to.filter(x => busy[x]);
  if (dup.length) fail_(dup.join(', ') + (dup.length > 1 ? ' already have' : ' already has') + ' No. ' + no + ' (in the Inbox or On hand).');
  const direct = s_(rec.Category) === 'OUTGOING';
  const purpose = s_(opt.purpose).slice(0, 120) || 'For appropriate action';
  const text = s_(opt.note).slice(0, 1000);
  const rows = to.map(x => ({
    Id: uid_('M'), TrackNo: no, ParentId: s_(row.Id), FromOffice: c.office, ToOffice: x, Purpose: purpose, Note: text,
    SentAt: c.now, SentBy: c.user.username, SentByName: c.user.name,
    Status: direct ? 'DELIVERED' : 'PENDING',
    RespondedAt: direct ? c.now : '', RespondedBy: '', RespondedByName: '', ResponseNote: '',
    Hold: direct ? 'HELD' : '', HoldAt: direct ? c.now : '', HoldBy: '', HoldNote: ''
  }));
  add_(c.mov, rows);
  if (!opt.keepCopy) {
    row.Hold = 'FORWARDED'; row.HoldAt = c.now; row.HoldBy = c.user.username; row.HoldNote = 'To ' + to.join(', ');
    save_(c.mov, row);
  }
  touch_(c, no);
  note_(c, no, direct ? 'Delivered' : 'Sent', 'To ' + to.join(', ') + ' · ' + purpose + (text ? ' · "' + text + '"' : '') + (opt.keepCopy ? ' · kept a copy on hand' : ''));
  return { no: no, to: to, direct: direct };
}

/** After a return or recall, the sender gets it back on hand — unless another copy it sent is still moving. */
function restoreParent_(c, m, why) {
  const p = c.mov.rows.find(r => s_(r.Id) === s_(m.ParentId));
  if (!p || s_(p.Hold) !== 'FORWARDED') return;
  const others = c.mov.rows.some(r => r !== m && s_(r.ParentId) === s_(p.Id) &&
    (s_(r.Status) === 'PENDING' || ['HELD', 'FORWARDED', 'DONE'].indexOf(s_(r.Hold)) >= 0));
  if (others) return;
  p.Hold = 'HELD'; p.HoldAt = c.now; p.HoldNote = why;
  save_(c.mov, p);
}

/* ================================================================ FILE NUMBERS
   The suggestion is the number after the latest logged record, skipping numbers already used.
   The person logging may type another number; it must not be in use. */
function usedNos_(recs) { const u = {}; recs.forEach(r => { const n = n_(r.TrackNo); if (n) u[n] = 1; }); return u; }
function nextNo_(recs, set, used) {
  used = used || usedNos_(recs);
  let latest = null;
  recs.forEach(r => { if (n_(r.TrackNo) && (!latest || (ms_(r.CreatedAt) || 0) >= (ms_(latest.CreatedAt) || 0))) latest = r; });
  let n = Math.max(latest ? n_(latest.TrackNo) + 1 : 1, Math.floor(n_(set.START_NUMBER)) || 1);
  while (used[n]) n++;
  return n;
}
function pickNo_(c, op) {
  const used = usedNos_(c.rec.rows);
  const typed = s_(op.fileNo).replace(/^no\.?\s*/i, '').replace(/^#/, '');
  if (!typed) return nextNo_(c.rec.rows, c.set, used);
  if (!/^\d{1,9}$/.test(typed) || Number(typed) < 1) fail_('Type the file number as digits only, like 125.');
  let n = Number(typed);
  if (used[n]) {
    if (op.fileNoAuto) { while (used[n]) n++; return n; }  // the suggested number was taken a moment ago: take the next free one
    fail_('No. ' + n + ' is already used. The next free number is ' + nextNo_(c.rec.rows, c.set, used) + '.');
  }
  return n;
}

/** The log form asks this before it closes, so a typed number already in use is caught while the form is still open. */
function apiCheckNo(token, no) {
  const user = auth_(token);
  const set = settings_();
  const recs = table_(SH.REC).rows;
  const used = usedNos_(recs);
  const n = Number(s_(no).replace(/^no\.?\s*/i, '').replace(/^#/, ''));
  return { no: n, used: !!(n && used[n]), next: canLog_(user, set) ? nextNo_(recs, set, used) : '' };
}

/* ================================================================ SUGGESTIONS FOR THE LOG FORM
   Earlier entries (newest first), so the person logging picks instead of retyping. */
function apiSuggest(token) {
  const user = auth_(token);
  const set = settings_();
  const all = seeAll_(user, set);
  const recs = table_(SH.REC).rows;
  const offices = [], persons = [], tos = [], subjects = [];
  const seen = { o: {}, p: {}, t: {}, s: {} };
  const put = (list, key, v, extra) => {
    v = s_(v);
    const k = v.toLowerCase();
    if (!v || seen[key][k]) return;
    seen[key][k] = 1;
    list.push(extra ? Object.assign({ v: v }, extra) : v);
  };
  for (let i = recs.length - 1, k = 0; i >= 0 && k < 3000; i--) {
    const r = recs[i];
    if (!all && s_(r.OriginOffice) !== user.office) continue;
    k++;
    const o = s_(r.FromOffice) || s_(r.FromParty);
    put(offices, 'o', o);
    if (s_(r.FromPerson)) put(persons, 'p', r.FromPerson, { o: o });
    put(tos, 't', r.ToParty);
    if (subjects.length < 300) put(subjects, 's', r.Subject);
  }
  return {
    next: canLog_(user, set) ? nextNo_(recs, set) : '',
    offices: offices.slice(0, 500), persons: persons.slice(0, 500), to: tos.slice(0, 300), subjects: subjects
  };
}

const ACT = {
  CREATE(c, op) {
    if (!canLog_(c.user, c.set)) {
      fail_('Only ' + (list_(c.set.LOG_OFFICES).join(', ') || 'the assigned offices') + ' can log new records and give tracking numbers.');
    }
    if (op.opId) {
      const dup = c.rec.rows.find(r => s_(r.OpId) === s_(op.opId));
      if (dup) return { no: n_(dup.TrackNo) };
    }
    const f = fields_(op.fields, true);
    if (!f.Priority) f.Priority = 'Normal';
    if (f.Category === 'INCOMING' && !f.DocDate) fail_('Type the document date (the date written on the incoming document).');
    const no = pickNo_(c, op);
    const r = Object.assign({}, f, {
      TrackNo: no, OriginOffice: c.office, CreatedAt: c.now, CreatedBy: c.user.username, CreatedByName: c.user.name,
      UpdatedAt: c.now, OpId: s_(op.opId)
    });
    add_(c.rec, [r]);
    c.recByNo[no] = r;
    const root = {
      Id: uid_('M'), TrackNo: no, ParentId: '', FromOffice: '', ToOffice: c.office, Purpose: 'Logged', Note: '',
      SentAt: c.now, SentBy: c.user.username, SentByName: c.user.name, Status: 'ACCEPTED',
      RespondedAt: c.now, RespondedBy: c.user.username, RespondedByName: c.user.name, ResponseNote: '',
      Hold: 'HELD', HoldAt: c.now, HoldBy: c.user.username, HoldNote: ''
    };
    add_(c.mov, [root]);
    note_(c, no, 'Logged', CATS[f.Category] + (f.DocType ? ' · ' + f.DocType : '') + ' · ' + f.Subject);
    let sent = null;
    if (op.send && op.send.to && op.send.to.length) sent = send_(c, root, op.send);
    return { no: no, sent: sent };
  },

  SEND(c, op) {
    const row = mv_(c, op.id);
    if (s_(row.ToOffice) !== c.office || s_(row.Hold) !== 'HELD') fail_('No. ' + n_(row.TrackNo) + ' is no longer on hand in your office.');
    return send_(c, row, op);
  },

  ACCEPT(c, op) {
    const ids = [].concat(op.ids || op.id || []).map(s_).filter(Boolean);
    const done = [], skipped = [];
    ids.forEach(id => {
      const m = c.mov.rows.find(r => s_(r.Id) === id);
      if (!m || s_(m.ToOffice) !== c.office || s_(m.Status) !== 'PENDING') { skipped.push(m ? n_(m.TrackNo) : id); return; }
      m.Status = 'ACCEPTED'; m.RespondedAt = c.now; m.RespondedBy = c.user.username; m.RespondedByName = c.user.name;
      m.Hold = 'HELD'; m.HoldAt = c.now; m.HoldBy = c.user.username;
      save_(c.mov, m);
      touch_(c, m.TrackNo);
      done.push(n_(m.TrackNo));
      note_(c, n_(m.TrackNo), 'Accepted', 'From ' + s_(m.FromOffice));
    });
    if (!done.length) fail_('Nothing to accept. It was already handled or recalled by the sender.');
    return { nos: done, skipped: skipped };
  },

  RETURN(c, op) {
    const m = mv_(c, op.id);
    const reason = s_(op.reason).slice(0, 1000);
    if (s_(m.ToOffice) !== c.office || s_(m.Status) !== 'PENDING') fail_('No. ' + n_(m.TrackNo) + ' is no longer in your Inbox.');
    if (!reason) fail_('Type the reason for returning it.');
    m.Status = 'RETURNED'; m.RespondedAt = c.now; m.RespondedBy = c.user.username; m.RespondedByName = c.user.name;
    m.ResponseNote = reason; m.Hold = '';
    save_(c.mov, m);
    restoreParent_(c, m, 'Returned by ' + c.office);
    touch_(c, m.TrackNo);
    note_(c, n_(m.TrackNo), 'Returned', 'To ' + s_(m.FromOffice) + ' · "' + reason + '"');
    return { no: n_(m.TrackNo) };
  },

  RECALL(c, op) {
    const m = mv_(c, op.id);
    if (s_(m.FromOffice) !== c.office) fail_('Only the office that sent it can recall it.');
    const kids = c.mov.rows.some(r => s_(r.ParentId) === s_(m.Id));
    const ok = s_(m.Status) === 'PENDING' || (s_(m.Status) === 'DELIVERED' && s_(m.Hold) === 'HELD' && !kids);
    if (!ok) fail_('It can no longer be recalled. ' + s_(m.ToOffice) + ' already acted on it.');
    m.Status = 'RECALLED'; m.RespondedAt = c.now; m.RespondedBy = c.user.username; m.RespondedByName = c.user.name;
    m.ResponseNote = s_(op.reason).slice(0, 500); m.Hold = '';
    save_(c.mov, m);
    restoreParent_(c, m, 'Recalled from ' + s_(m.ToOffice));
    touch_(c, m.TrackNo);
    note_(c, n_(m.TrackNo), 'Recalled', 'From ' + s_(m.ToOffice));
    return { no: n_(m.TrackNo) };
  },

  DONE(c, op) {
    const m = mv_(c, op.id);
    if (s_(m.ToOffice) !== c.office || s_(m.Hold) !== 'HELD') fail_('No. ' + n_(m.TrackNo) + ' is no longer on hand in your office.');
    m.Hold = 'DONE'; m.HoldAt = c.now; m.HoldBy = c.user.username; m.HoldNote = s_(op.note).slice(0, 1000);
    save_(c.mov, m);
    touch_(c, m.TrackNo);
    note_(c, n_(m.TrackNo), 'Done', s_(op.note) ? '"' + s_(op.note) + '"' : '');
    return { no: n_(m.TrackNo) };
  },

  REOPEN(c, op) {
    const m = mv_(c, op.id);
    if (s_(m.ToOffice) !== c.office || s_(m.Hold) !== 'DONE') fail_('No. ' + n_(m.TrackNo) + ' is not marked done in your office.');
    m.Hold = 'HELD'; m.HoldAt = c.now; m.HoldBy = c.user.username; m.HoldNote = 'Reopened';
    save_(c.mov, m);
    touch_(c, m.TrackNo);
    note_(c, n_(m.TrackNo), 'Reopened', '');
    return { no: n_(m.TrackNo) };
  },

  EDIT(c, op) {
    const r = rec_(c, op.no);
    const no = n_(r.TrackNo);
    if (!c.isAdmin && s_(r.OriginOffice) !== c.office) fail_('Only ' + s_(r.OriginOffice) + ', the office that logged it, can edit the details.');
    const f = fields_(op.fields, false);
    const changes = [];
    if (f.FromOffice !== undefined && s_(r.FromParty) && !s_(r.FromOffice)) { r.FromOffice = s_(r.FromParty); r.FromParty = ''; }
    Object.keys(f).forEach(k => {
      const before = (k === 'DocDate' || k === 'DueDate') ? dateOut_(r[k]) : s_(r[k]);
      const after = s_(f[k]);
      if (before !== after) {
        const show = v => (k === 'Category' ? (CATS[v] || v) : v) || '—';
        changes.push(FIELD_LABELS[k] + ': ' + show(before) + ' → ' + show(after));
        r[k] = f[k];
      }
    });
    if (!changes.length) return { no: no, unchanged: true };
    r.UpdatedAt = c.now;
    save_(c.rec, r);
    note_(c, no, 'Edited', changes.join('; '));
    return { no: no };
  },

  ATTACH(c, op) {
    const r = rec_(c, op.no);
    const no = n_(r.TrackNo);
    if (!c.isAdmin && !seeAll_(c.user, c.set) && !involved_(c, no)) fail_('Only offices that handled No. ' + no + ' can attach its scan.');
    if (op.clear) {
      const old = s_(r.FileName);
      setFile_(r, { id: '', name: '', mime: '' });
      r.UpdatedAt = c.now;
      save_(c.rec, r);
      note_(c, no, 'Scan removed', old);
      return { no: no };
    }
    const id = s_(op.fileId) || idFromLink_(op.link);
    if (!id) fail_('Paste a Google Drive link, or choose a file.');
    let info;
    try { const f = DriveApp.getFileById(id); info = { id: id, name: f.getName(), mime: f.getMimeType() }; }
    catch (e) { fail_('That Drive file could not be opened. Check the link, and that the account running this app can open it.'); }
    share_(id);
    const had = s_(r.FileId);
    setFile_(r, info);
    r.UpdatedAt = c.now;
    save_(c.rec, r);
    note_(c, no, had ? 'Scan replaced' : 'Scan attached', info.name);
    return { no: no, file: info };
  }
};

/* ================================================================ ADMIN */
function admin_(token) {
  const user = auth_(token);
  if (user.role !== 'Admin') fail_('This page is for the system admin only.');
  return user;
}

function apiAdmin(token) {
  admin_(token);
  const set = settings_();
  let folderUrl = '';
  try { const f = folder_(set, false); folderUrl = f ? f.getUrl() : ''; } catch (e) { /* no folder */ }
  return {
    users: table_(SH.USERS).rows.filter(u => s_(u.Username)).map(u => Object.assign(userOut_(u), {
      active: active_(u.Active), lastLogin: ms_(u['Last Login']),
      plain: s_(u.Password) !== '' && s_(u.Password).indexOf('sha256$') !== 0
    })),
    org: orgOut_(org_()),
    settings: table_(SH.SET).rows.filter(r => s_(r.Key)).map(r => ({ key: s_(r.Key).toUpperCase(), value: s_(r.Value), note: s_(r.Notes) })),
    folderUrl: folderUrl
  };
}

/** kind: 'user' | 'office' | 'setting' */
function apiAdminSave(token, kind, o, opId) {
  const user = admin_(token);
  o = o || {};
  opId = s_(opId);
  const cache = CacheService.getScriptCache();
  const seen = opId ? cache.get('op:' + opId) : null;
  if (seen) return JSON.parse(seen);
  return locked_(() => {
    let details = '';
    if (kind === 'user') {
      const t = table_(SH.USERS);
      const username = s_(o.username).toLowerCase();
      if (!/^[a-z0-9._-]{2,40}$/.test(username)) fail_('Username: 2 to 40 letters, numbers, dots, dashes or underscores.');
      const org = org_();
      const office = s_(o.office).toUpperCase();
      if (!org.map[office]) fail_('Pick a valid office.');
      let u = t.rows.find(r => s_(r.Username).toLowerCase() === username);
      const isNew = !u;
      if (isNew && o.isNew === false) fail_('That account no longer exists.');
      if (!isNew && o.isNew) fail_('The username "' + username + '" is already taken.');
      if (isNew) u = { Username: username };
      u['Full Name'] = s_(o.name).slice(0, 120);
      u.Designation = s_(o.designation).slice(0, 120);
      u.Office = office;
      u.Role = s_(o.role) === 'Admin' ? 'Admin' : 'User';
      u.Active = o.active === false ? 'FALSE' : 'TRUE';
      if (s_(o.password)) {
        if (s_(o.password).length < 6) fail_('Use at least 6 characters for the password.');
        u.Password = makePw_(s_(o.password));
        u['Session Token'] = '';
      } else if (isNew) fail_('Give the new account a password.');
      if (u.Active === 'FALSE') u['Session Token'] = '';
      if (isNew) add_(t, [u]); else save_(t, u);
      details = (isNew ? 'Added account ' : 'Updated account ') + username + ' (' + office + ')' + (s_(o.password) ? ', password set' : '');
    } else if (kind === 'office') {
      const t = table_(SH.OFF);
      const code = s_(o.code).toUpperCase();
      if (!/^[A-Z0-9-]{2,12}$/.test(code)) fail_('Office code: 2 to 12 capital letters, numbers or dashes.');
      const org = org_();
      const parent = s_(o.parent).toUpperCase();
      if (parent && !org.map[parent]) fail_('The parent office "' + parent + '" does not exist.');
      if (parent && org.map[code] && under_(org, code).has(parent)) fail_(parent + ' is under ' + code + ', so it cannot be its parent.');
      if (parent === code) fail_('An office cannot be its own parent.');
      let r = t.rows.find(x => s_(x.Code).toUpperCase() === code);
      const isNew = !r;
      if (!isNew && o.isNew) fail_('The office code "' + code + '" is already used.');
      if (isNew) r = { Code: code };
      r['Office Name'] = s_(o.name).slice(0, 160) || code;
      r.Level = LEVELS.indexOf(s_(o.level)) >= 0 ? s_(o.level) : 'Unit';
      r.Parent = parent;
      r.Head = s_(o.head).slice(0, 160);
      r.Order = s_(o.order) === '' ? '' : n_(o.order);
      r.Active = o.active === false ? 'FALSE' : 'TRUE';
      if (isNew) add_(t, [r]); else save_(t, r);
      details = (isNew ? 'Added office ' : 'Updated office ') + code + (parent ? ' under ' + parent : '');
    } else if (kind === 'setting') {
      const t = table_(SH.SET);
      const key = s_(o.key).toUpperCase();
      if (!/^[A-Z0-9_]{2,40}$/.test(key)) fail_('Invalid setting name.');
      let r = t.rows.find(x => s_(x.Key).toUpperCase() === key);
      if (!r) { r = { Key: key, Value: s_(o.value), Notes: '' }; add_(t, [r]); }
      else { r.Value = s_(o.value); save_(t, r); }
      details = 'Setting ' + key + ' = ' + s_(o.value);
    } else {
      fail_('Unknown item.');
    }
    log_([{ no: '', office: user.office, user: user, action: 'Admin', details: details }], opId);
    bump_();
    const out = { ok: true, details: details };
    if (opId) cache.put('op:' + opId, JSON.stringify(out), CFG.OP_MEMORY_SEC);
    return out;
  });
}

/* ================================================================ SETUP (run once from the editor) */
function setupSystem() {
  const ss = ss_();
  const made = [];
  migrateFrom_(ss);
  Object.keys(COLS).forEach(name => { if (ensureSheet_(ss, name, COLS[name])) made.push(name); });

  const lines = [];
  const off = table_(SH.OFF);
  if (!off.rows.length) {
    add_(off, SEED_OFFICES.map(o => ({ Code: o[0], 'Office Name': o[1], Level: o[2], Parent: o[3], Head: o[4], Order: o[5], Active: 'TRUE' })));
    lines.push('Added ' + SEED_OFFICES.length + ' BOE offices (OD down to the sections).');
  }

  const users = table_(SH.USERS);
  if (!users.rows.length) {
    const org = org_();
    const acc = orgOut_(org).map(o => ({
      Username: o.code.toLowerCase(), Password: o.code.toLowerCase() + '@boe', 'Full Name': o.name,
      Designation: 'Office account', Office: o.code, Role: o.code === 'ADMIN' ? 'Admin' : 'User', Active: 'TRUE'
    }));
    add_(users, acc);
    lines.push('Added one account per office. Username = office code in small letters, password = code + "@boe".');
    acc.forEach(a => lines.push('   ' + a.Username + '  /  ' + a.Password + (a.Role === 'Admin' ? '   (system admin)' : '')));
    lines.push('Change each password after the first sign-in (menu at the top right of the app).');
  }

  const st = table_(SH.SET);
  const have = {};
  st.rows.forEach(r => { have[s_(r.Key).toUpperCase()] = r; });
  const missing = DEFAULT_SETTINGS.filter(d => !have[d[0]]).map(d => ({ Key: d[0], Value: d[1], Notes: d[2] }));
  add_(st, missing);
  if (missing.length) lines.push('Added ' + missing.length + ' settings.');

  const set = settings_();
  if (!idFromLink_(set.FILES_FOLDER_ID)) {
    try {
      let parent = null;
      try { const it = DriveApp.getFileById(ss.getId()).getParents(); if (it.hasNext()) parent = it.next(); } catch (e) { /* root */ }
      const folder = (parent || DriveApp).createFolder('BOE RMS – Scans');
      const t = table_(SH.SET);
      const r = t.rows.find(x => s_(x.Key).toUpperCase() === 'FILES_FOLDER_ID');
      r.Value = folder.getId();
      save_(t, r);
      lines.push('Made the scans folder: ' + folder.getUrl());
    } catch (e) { lines.push('Could not make the scans folder (' + e.message + '). Put a folder link in Settings ▸ FILES_FOLDER_ID.'); }
  }

  PropertiesService.getScriptProperties().setProperty('SCHEMA', SCHEMA);
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) { try { ss.deleteSheet(blank); } catch (e) { /* keep it */ } }
  bump_();
  SpreadsheetApp.flush();
  const msg = ['BOE Records Management System is set up.',
    made.length ? 'New sheets: ' + made.join(', ') : 'All sheets were already there (missing columns were added).'].concat(lines).join('\n');
  Logger.log(msg);
  try { ss.toast('Setup finished. See the execution log for the accounts.', 'BOE RMS', 8); } catch (e) { /* run from the editor */ }
  return msg;
}

function ensureSheet_(ss, name, cols) {
  let sh = ss.getSheetByName(name);
  const isNew = !sh;
  if (!sh) sh = ss.insertSheet(name);
  const lastCol = sh.getLastColumn();
  const have = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(s_) : [];
  if (!have.filter(Boolean).length) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
  } else {
    const miss = cols.filter(c => have.indexOf(c) < 0);
    if (miss.length) sh.getRange(1, have.length + 1, 1, miss.length).setValues([miss]);
  }
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(s_);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#0D47A1').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  const rows = Math.max(sh.getMaxRows() - 1, 1);
  (TEXT_COLS[name] || []).forEach(c => { const i = head.indexOf(c); if (i >= 0) sh.getRange(2, i + 1, rows, 1).setNumberFormat('@'); });
  (TIME_COLS[name] || []).forEach(c => { const i = head.indexOf(c); if (i >= 0) sh.getRange(2, i + 1, rows, 1).setNumberFormat('yyyy-mm-dd hh:mm'); });
  return isNew;
}
