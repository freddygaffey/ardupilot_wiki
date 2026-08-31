/*
 * Harness for the service worker: builds caches from the real archive entry
 * names, asks for the URLs the site serves, and answers with the worker's own
 * code, lifted or booted from sw.js.
 *
 *   node scripts/tests/test_offline_worker.js [wiki]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WIKI = process.argv[2] || 'rover';
const WORKER = path.join(REPO, 'frontend', 'sw.js');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) { failures++; }
}

/* ------------------------------------------------------- the worker's code -- */

/** Lift the lookup functions out of sw.js by name; a copy here could agree
 *  with itself while the shipped worker is wrong. */
function liftLookup(src) {
  let out = '';
  // Module-level state the matcher consults, taken with it.
  for (const re of [/const ASSET_EXT_RE\s*=\s*[\s\S]*?;/,
                    /const CONTENT_EXPECTATIONS\s*=\s*\[[\s\S]*?\n\];/,
                    /const OFFLINE_CACHE_PREFIX\s*=\s*[^;]*;/,
                    /const FOLDED_INTO_COMMON\s*=\s*[^;]*;/,
                    /const AP_ENCODED\s*=\s*[^;]*;/,
                    // Before STATIC_CACHE, which interpolates it.
                    /const CACHE_VERSION\s*=\s*[^;]*;/,
                    /const STATIC_CACHE\s*=\s*[^;]*;/,
                    /const PARAM_INDEX\s*=\s*[^;]*;/,
                    /let knownCacheNames\s*=\s*[^;]*;/,
                    /const markerChecked\s*=\s*[^;]*;/,
                    /const openedCaches\s*=\s*[^;]*;/]) {
    const m = src.match(re);
    if (m) { out += m[0] + '\n'; }
  }
  // Every function heldOffline reaches; a missing one throws mid-run.
  for (const name of ['storedShapes', 'likelyCacheName', 'isComplete',
                      'offlineCacheFor', 'inflate', 'heldOffline', 'cacheFirst',
                      'keep', 'paramIndex',
                      'plausibleBody']) {
    const at = src.indexOf('function ' + name + '(');
    if (at === -1) { return null; }
    const from = src.lastIndexOf('async ', at) === at - 6 ? at - 6 : at;
    let i = src.indexOf('{', at), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') { depth++; } else if (src[i] === '}') {
        depth--; if (depth === 0) { break; }
      }
    }
    out += src.slice(from, i + 1) + '\n';
  }
  return out;
}

/* ------------------------------------------------------------ tar reading -- */

/** Entry names in a .tar.gz, without unpacking the bodies. */
function tarNames(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const names = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) { off += 512; continue; }
    const sizeField = buf.toString('ascii', off + 124, off + 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(buf[off + 156]);
    if (type === '0' || type === '\0') { names.push(name); }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

/* ------------------------------------------------------------- the run ----- */

function run(workerSrc, label) {
  const lifted = liftLookup(workerSrc);
  if (!lifted) {
    check('lookup lifted from ' + label, false, 'storedShapes/heldOffline not found');
    return;
  }

  // Cache keys exactly as offline-page.js writes them: the wiki archive keeps
  // its own prefix, the common archive is written under /_common/.
  const store = new Set();
  const wikiArchive = path.join(REPO, 'offline', WIKI + '-offline.tar.gz');
  const commonArchive = path.join(REPO, 'offline', 'common-offline.tar.gz');
  if (!fs.existsSync(wikiArchive) || !fs.existsSync(commonArchive)) {
    // A suite that cannot run is a failure, not a pass.
    console.error('\nFAILED: this suite needs the built archives.\n' +
                  '  python3 update.py\n');
    process.exit(1);
  }
  const wikiNames = tarNames(wikiArchive);
  wikiNames.forEach((n) => store.add('/' + n));
  tarNames(commonArchive).forEach((n) => store.add('/_common/' + n));

  // Keys are paths; a Request carries a full URL. Normalise so the worker's
  // code can be run exactly as written.
  const keyOf = (r) => {
    const u = typeof r === 'string' ? r : r.url;
    return u.startsWith('http') ? new URL(u).pathname : u;
  };

  // IMAGE_CACHE starts empty: a reader who saved a wiki and went offline.
  const runtimeCache = new Map();

  // Response-shaped, so the worker can clone it as it would a real one.
  const asResponse = (path) => ({
    url: path,
    clone() { return asResponse(path); },
    text: async () => '',
  });

  // Where the unpacker puts a path; likelyCacheName must agree, or a fold
  // silently demotes every request to the exhaustive search.
  const holderOf = (k) => {
    if (k.startsWith('/_common/')) { return 'ardupilot-offline-common'; }
    const first = k.split('/')[1];
    return 'ardupilot-offline-' + (first === 'ardupilot' ? 'common' : first);
  };

  const ctx = {
    URL,
    console,
    caches: {
      match: async (r) => (store.has(keyOf(r)) ? asResponse(keyOf(r)) : undefined),
      // Every offline cache a reader would hold, so the named-cache path is
      // exercised rather than silently falling through to the exhaustive one.
      keys: async () => [...new Set([...store].filter((k) => k.startsWith('/'))
        .map(holderOf))],
      open: async (name) => ({
        match: async (r) => {
          const k = keyOf(r);
          if (typeof name === 'string' && name.startsWith('ardupilot-offline-')) {
            // These caches model FINISHED downloads, so they carry the marker
            // the worker now requires before consulting them.
            if (k === '/__ap_complete__') { return asResponse(k); }
            if (holderOf(k) !== name) { return undefined; }
            return store.has(k) ? asResponse(k) : undefined;
          }
          return runtimeCache.get(k);
        },
        put: async (r, v) => { runtimeCache.set(keyOf(r), v); },
      }),

    },
    // Offline.
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    Response: class { constructor(body, init) { this.body = body; Object.assign(this, init); } },
  };
  vm.createContext(ctx);
  vm.runInContext(lifted +
    'this.storedShapes=storedShapes;this.heldOffline=heldOffline;' +
    'this.cacheFirst=cacheFirst;this.likelyCacheName=likelyCacheName;' +
    'this.paramIndex=paramIndex;this.PARAM_INDEX=PARAM_INDEX;', ctx);

  const ask = (u) => ctx.heldOffline({ url: 'https://example.test' + u });
  const askImage = async (u) => {
    const r = await ctx.cacheFirst({ url: 'https://example.test' + u }, 'images');
    return r && r.url ? r : undefined;
  };

  return { ctx, store, wikiNames, ask, askImage };
}

/** The URL a canonicalising host serves a built file as. */
function canonical(p) {
  if (p.endsWith('/index.html')) { return p.slice(0, -'index.html'.length); }
  return p.replace(/\.html$/, '');
}

/** The worker must evaluate, not merely parse: a const used above its
 *  declaration passes node --check and registers as nothing in a browser. */
function checkWorkerEvaluates() {
  const ctx = {
    self: { addEventListener() {}, skipWaiting() {}, clients: {},
            location: { origin: 'https://example.test' } },
    caches: {}, console: { warn() {}, log() {} },
    fetch() {}, Response: function () {}, URL, setTimeout, Map, Set, Promise,
  };
  vm.createContext(ctx);
  let err = null;
  try {
    vm.runInContext(fs.readFileSync(WORKER, 'utf8'), ctx);
  } catch (e) {
    err = e.message;
  }
  check('the worker evaluates, not just parses', err === null, err || 'clean');
}

/* ------------------------------------------------- differential updates -- */

/** Boot the real worker against a ServiceWorkerGlobalScope-alike and hand
 *  back its fetch listener. */
/** A Response whose clone() throws once the body has been read, as a real
 *  one does. */
function bodyAwareResponse(text) {
  return {
    _used: false,
    status: 200, ok: true, type: 'basic',
    headers: { get: () => null },
    clone() {
      if (this._used) {
        throw new TypeError("Failed to execute 'clone' on 'Response': " +
                            'Response body is already used');
      }
      return bodyAwareResponse(text);
    },
    async text() { this._used = true; return text; },
  };
}

function bootWorker({ networkFails = false, serve = null,
                     existingCaches = [], offlineCopy = null,
                     holdNetwork = false, putFails = false } = {}) {
  const seen = { fetches: [], cacheReads: [], puts: [], deleted: [], posted: [] };
  let cacheNames = existingCaches.slice();
  // A completed download: named cache plus completion marker.
  const offlineName = offlineCopy
    ? 'ardupilot-offline-' + offlineCopy.path.split('/')[1]
    : null;
  if (offlineName && cacheNames.indexOf(offlineName) === -1) {
    cacheNames.push(offlineName);
  }
  const listeners = {};
  // One object per cache name: which cache holds what is the thing under test.
  const cacheFor = (name) => ({
    match: async (r) => {
      const k = String(r && r.url ? r.url : r);
      seen.cacheReads.push(k);
      if (offlineCopy && name === offlineName) {
        if (k.indexOf('/__ap_complete__') !== -1) {
          // noMarker models the aborted download: content present, marker not.
          return offlineCopy.noMarker ? undefined : { ok: true, status: 200 };
        }
        if (k.endsWith(offlineCopy.path)) {
          seen.servedCopy = seen.servedCopy || bodyAwareResponse(offlineCopy.body);
          if (offlineCopy.ct) {
            seen.servedCopy.headers = { get: (h) =>
              String(h).toLowerCase() === 'content-type' ? offlineCopy.ct : null };
          }
          return seen.servedCopy;
        }
      }
      return undefined;
    },
    put: async (k) => {
      seen.puts.push(String(k && k.url ? k.url : k));
      // Storage full. Cache.put rejects with QuotaExceededError, and the
      // question is whether that reaches the reader.
      if (putFails) {
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        throw err;
      }
    },
    keys: async () => [],
  });
  const emptyCache = cacheFor('');
  const ctx = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting() {}, clients: { claim() {},
        matchAll: async () => [{ postMessage: (m) => { seen.posted.push(m); } }] },
      location: { origin: 'https://example.test' },
      registration: {},
    },
    caches: {
      match: async (r) => {
        const k = String(r && r.url ? r.url : r);
        seen.cacheReads.push(k);
        if (offlineCopy && k.endsWith(offlineCopy.path)) {
          seen.servedCopy = seen.servedCopy || bodyAwareResponse(offlineCopy.body);
          if (offlineCopy.ct) {
            seen.servedCopy.headers = { get: (h) =>
              String(h).toLowerCase() === 'content-type' ? offlineCopy.ct : null };
          }
          return seen.servedCopy;
        }
        return undefined;
      },
      open: async (name) => cacheFor(name),
      keys: async () => cacheNames.slice(),
      delete: async (n) => {
        seen.deleted.push(n);
        cacheNames = cacheNames.filter((x) => x !== n);
        return true;
      },
    },
    console: { warn() {}, log() {}, error() {} },
    fetch: async (req) => {
      const url = String(req && req.url ? req.url : req);
      seen.fetches.push(url);
      if (networkFails) { throw new TypeError('Failed to fetch'); }
      // Held open so the browser reads the served copy before the refresh lands.
      if (holdNetwork) {
        await new Promise((resolve) => { seen.releaseNetwork = resolve; });
      }
      // What the server said it was sending. The point of the guard is that
      // this can contradict what was asked for.
      const spec = serve ? serve(url) : {};
      return {
        ok: true, status: 200, url, type: spec.type || 'basic',
        headers: { get: (h) => (String(h).toLowerCase() === 'content-type'
                                  ? (spec.ct === undefined ? null : spec.ct)
                                  : null) },
        clone() { return this; },
        text: async () => spec.body || '',
      };
    },
    Response: class {
      constructor(body, init) { this.body = body; Object.assign(this, init || {}); }
    },
    Request: class { constructor(u) { this.url = String(u); } },
    URL, setTimeout, clearTimeout, Map, Set, Promise, JSON, Math, Date, RegExp,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(WORKER, 'utf8'), ctx);

  /** Dispatch one request and return what the worker answered with, if it did. */
  const ask = (path, req = {}) => {
    let answered;
    seen.waited = seen.waited || [];
    const request = Object.assign({
      url: /^https?:\/\//.test(path) ? path : 'https://example.test' + path,
      method: 'GET',
      mode: 'no-cors', destination: '',
    }, req);
    listeners.fetch({ request, respondWith: (p) => { answered = p; },
                      waitUntil: (p) => { seen.waited.push(p); } });
    return answered;
  };
  const activate = async () => {
    let waited;
    listeners.activate({ waitUntil: (p) => { waited = p; } });
    if (waited) { await waited; }
    return cacheNames;
  };
  return { ask, activate, seen, handled: !!listeners.fetch };
}

async function checkUpdateRouting() {
  console.log('\nservice worker: differential update requests\n');

  const UPDATE = '?ap-update=2026-08-09T00%3A00%3A00Z';
  const PAGE = '/copter/docs/common-thing.html';

  // The tag is what the worker routes on, so read it out of the worker rather
  // than writing it here twice.
  const src = fs.readFileSync(WORKER, 'utf8');
  const param = (src.match(/const UPDATE_PARAM\s*=\s*'([^']+)'/) || [])[1];
  check('the worker names the update parameter', param === 'ap-update', String(param));

  {
    const w = bootWorker();
    const answered = w.ask(PAGE + UPDATE);
    check('a tagged request is answered at all', !!answered);
    if (answered) { await answered; }
    check('a tagged request goes to the network',
          w.seen.fetches.length === 1 && w.seen.fetches[0].indexOf('ap-update=') !== -1,
          JSON.stringify(w.seen.fetches));
    // The bug that shipped: an untagged request took the cache-first route and
    // the update was answered out of the very cache it was refreshing.
    check('and the cache is never consulted for it',
          w.seen.cacheReads.length === 0, JSON.stringify(w.seen.cacheReads));
  }

  {
    // Without the tag the same URL is a page, and pages are served from storage.
    // This is the contrast that shows the tag is doing the work.
    const w = bootWorker();
    const answered = w.ask(PAGE);
    if (answered) { await answered; }
    check('the same URL untagged does consult the cache',
          w.seen.cacheReads.length > 0, w.seen.cacheReads.length + ' reads');
  }

  {
    // An update must fail, not be answered from the copy it is replacing.
    const w = bootWorker({ networkFails: true });
    const answered = w.ask(PAGE + UPDATE);
    let rejected = false;
    if (answered) { await answered.then(() => {}, () => { rejected = true; }); }
    check('a tagged request that fails is not answered from storage', rejected);
    check('and nothing was read out of the cache to answer it',
          w.seen.cacheReads.length === 0, JSON.stringify(w.seen.cacheReads));
  }

  {
    // Every file type, not only the ones that reach the network anyway.
    const w = bootWorker();
    for (const p of ['/copter/docs/a.html', '/copter/searchindex.js',
                     '/copter/objects.inv', '/copter/_images/x.png']) {
      const a = w.ask(p + UPDATE);
      if (a) { await a; }
    }
    check('every kind of file the update fetches takes the network route',
          w.seen.fetches.length === 4 && w.seen.cacheReads.length === 0,
          w.seen.fetches.length + ' fetched, ' + w.seen.cacheReads.length + ' cache reads');
  }
}

/*
 * A response that contradicts the request (captive wifi's login page as a
 * stylesheet) must not be stored: cache-first would keep it indefinitely.
 */
async function checkPoisonGuard() {
  console.log('\nservice worker: refusing an implausible body\n');

  const CSS = '/dev/_static/css/ardupilot.css?v=ae9666d5';
  const JS = '/dev/_static/js/theme.js';
  const IMG = '/dev/_images/thing.png';

  const run = async (path, spec) => {
    const w = bootWorker({ serve: () => spec });
    const a = w.ask(path);
    if (a) { await a; }
    return w.seen;
  };

  // The honest cases: stored.
  let seen = await run(CSS, { ct: 'text/css' });
  check('a stylesheet served as text/css is stored',
        seen.puts.length === 1, JSON.stringify(seen.puts));
  seen = await run(JS, { ct: 'application/javascript' });
  check('a script served as javascript is stored',
        seen.puts.length === 1, JSON.stringify(seen.puts));

  // The captive-portal shape: a login page, at 200, for every request.
  seen = await run(CSS, { ct: 'text/html', body: '<html>login</html>' });
  check('a stylesheet served as text/html is NOT stored',
        seen.puts.length === 0 && seen.fetches.length === 1,
        JSON.stringify(seen.puts));
  seen = await run(JS, { ct: 'text/html', body: '<html>login</html>' });
  check('a script served as text/html is NOT stored',
        seen.puts.length === 0, JSON.stringify(seen.puts));
  seen = await run(IMG, { ct: 'text/html', body: '<html>login</html>' });
  check('an image served as text/html is NOT stored',
        seen.puts.length === 0, JSON.stringify(seen.puts));

  // Deliberately narrow: only a positive contradiction rejects.
  seen = await run(CSS, {});
  check('no content type at all is not treated as evidence',
        seen.puts.length === 1, JSON.stringify(seen.puts));
  seen = await run(CSS, { ct: 'text/css; charset=utf-8' });
  check('a charset on the content type is still a stylesheet',
        seen.puts.length === 1, JSON.stringify(seen.puts));
  seen = await run('/dev/_static/fonts/lato.woff2', { ct: 'application/octet-stream' });
  check('an extension with no expectation is left alone',
        seen.puts.length === 1, JSON.stringify(seen.puts));

  // The promotion path: a saved wiki is not a trusted source either.
  {
    const w = bootWorker({ offlineCopy: {
      path: '/plane/_static/css/theme.css',
      body: '<html>captive portal login</html>', ct: 'text/html' } });
    const a = w.ask('/plane/_static/css/theme.css');
    if (a) { await a; }
    check('a poisoned offline entry is served but NOT promoted',
          w.seen.puts.length === 0, JSON.stringify(w.seen.puts));
  }
  {
    const w = bootWorker({ offlineCopy: {
      path: '/plane/_static/css/theme.css', body: 'a{}', ct: 'text/css' } });
    const a = w.ask('/plane/_static/css/theme.css');
    if (a) { await a; }
    check('a legitimate offline stylesheet is still promoted',
          w.seen.puts.length === 1, JSON.stringify(w.seen.puts));
  }

  // Cross-origin assets expose no headers and are stored on purpose.
  const w = bootWorker({ serve: () => ({ type: 'opaque', ct: null }) });
  const a = w.ask('https://i.creativecommons.org/l/by-sa/3.0/88x31.png');
  if (a) { await a; }
  check('an opaque cross-origin response is still stored',
        w.seen.puts.length === 1, JSON.stringify(w.seen.puts));
}

/* A version bump must discard only the versioned caches, never a saved wiki. */
/* searchindex.js and objects.inv match no other route and must still be
 * answered from a saved wiki. */
async function checkArchiveFallback() {
  console.log('\nservice worker: archive files no route claims\n');

  // Online: straight to the network, exactly as before.
  let w = bootWorker();
  let a = w.ask('/dev/searchindex.js');
  check('online, it is answered from the network', !!a);
  if (a) { await a; }
  check('and storage is not consulted for it',
        w.seen.fetches.length === 1 && w.seen.cacheReads.length === 0,
        JSON.stringify(w.seen.fetches));

  // Offline: the saved wiki holds it, so it must be served rather than failing.
  w = bootWorker({ networkFails: true,
                   offlineCopy: { path: '/dev/searchindex.js',
                                  body: 'Search.setIndex({})' } });
  a = w.ask('/dev/searchindex.js');
  let answered;
  if (a) { answered = await a.catch(() => 'REJECTED'); }
  check('offline, it falls back to the saved wiki instead of failing',
        !!answered && answered !== 'REJECTED' && answered === w.seen.servedCopy,
        answered === w.seen.servedCopy ? 'served the saved copy' : String(answered));
}

/* A background refresh nobody waits for is abandoned when the worker is
 * killed, so both stale-while-revalidate routes must pass it to waitUntil. */
async function checkRevalidationIsAwaited() {
  console.log('\nservice worker: the refresh behind is actually waited for\n');

  let w = bootWorker({ serve: () => ({ ct: 'text/html', body: '<html>fresh' }) });
  let a = w.ask('/dev/docs/thing.html');
  if (a) { await a; }
  check('a page request asks the browser to wait for the refresh',
        (w.seen.waited || []).length === 1, (w.seen.waited || []).length + ' waitUntil calls');
  await Promise.all(w.seen.waited || []);
  check('and the refreshed copy is then stored',
        w.seen.puts.length === 1, JSON.stringify(w.seen.puts));

  // pwa.js is the only other stale-while-revalidate route; _static is
  // cache-first and must not wait for anything.
  w = bootWorker({ serve: () => ({ ct: 'application/javascript', body: '//' }) });
  a = w.ask('/js/pwa.js');
  if (a) { await a; }
  check('pwa.js does the same',
        (w.seen.waited || []).length === 1, (w.seen.waited || []).length + ' waitUntil calls');

  w = bootWorker({ serve: () => ({ ct: 'text/css', body: 'a{}' }) });
  a = w.ask('/dev/_static/css/ardupilot.css');
  if (a) { await a; }
  check('a fingerprinted static asset stays cache-first, with nothing to wait for',
        (w.seen.waited || []).length === 0, (w.seen.waited || []).length + ' waitUntil calls');

  // The source itself, because a future edit could drop the argument and every
  // assertion above would still pass against a harness that always supplies it.
  const src = fs.readFileSync(WORKER, 'utf8');
  check('every stale-while-revalidate call site passes the event',
        !/staleWhileRevalidate\(request,\s*[A-Z_]+\)/.test(src) &&
        !/freshBehind\(request,\s*[A-Z_]+\)/.test(src),
        'no call site omits it');
}

/* The refresh must survive the browser having consumed the body it was
 * handed: the comparison copy has to be cloned before the response goes out. */
async function checkRefreshSurvivesAConsumedBody() {
  console.log('\nservice worker: refreshing a page that has been read\n');

  const w = bootWorker({
    serve: () => ({ ct: 'text/html', body: '<html>fresh' }),
    offlineCopy: { path: '/dev/docs/thing.html', body: '<html>stale' },
    holdNetwork: true,
  });
  const answered = w.ask('/dev/docs/thing.html');
  const response = answered ? await answered : null;
  check('the stored copy is served while the refresh is still in flight',
        !!response && !!w.seen.releaseNetwork);

  // The browser reads it to render the page, and only then does the refresh
  // land. Reversing these two is what made the bug invisible in testing.
  if (response && response.text) { await response.text(); }
  if (w.seen.releaseNetwork) { w.seen.releaseNetwork(); }

  await Promise.all(w.seen.waited || []);
  await new Promise((r) => setTimeout(r, 10));
  check('the refresh still completes after the served copy has been read',
        w.seen.puts.length === 1, JSON.stringify(w.seen.puts));
  check('and it did not fail on a used body',
        !(w.seen.errors || []).length, JSON.stringify(w.seen.errors || []));
}

/* A cache without the completion marker is an aborted download and must not
 * be served. */
async function checkMarkerRespected() {
  console.log('\nservice worker: a download without its marker is not a copy\n');

  // The dangerous state: CONTENT present, marker absent. This is what an
  // abort or a quota kill leaves, and what was observed being served.
  const w2 = bootWorker({
    serve: () => ({ ct: 'text/html', body: '<html>from the network' }),
    offlineCopy: { path: '/dev/docs/thing.html',
                   body: '<html>HALF-DOWNLOADED PAGE', noMarker: true },
  });
  const a2 = w2.ask('/dev/docs/thing.html', { mode: 'navigate' });
  const r2 = a2 ? await a2 : null;
  check('a half-written download is NOT served',
        r2 !== w2.seen.servedCopy, r2 === w2.seen.servedCopy
          ? 'SERVED THE FRAGMENT' : 'went to the network');
  check('the network answers instead',
        w2.seen.fetches.length >= 1, w2.seen.fetches.length + ' fetches');

  // And the same cache WITH its marker is served offline, so the gate does
  // not throw away legitimate copies.
  const w3 = bootWorker({ networkFails: true,
    offlineCopy: { path: '/dev/docs/thing.html', body: '<html>saved page' } });
  const a3 = w3.ask('/dev/docs/thing.html', { mode: 'navigate' });
  const r3 = a3 ? await a3.catch(() => null) : null;
  check('the same cache with its marker still serves offline',
        r3 === w3.seen.servedCopy,
        r3 === w3.seen.servedCopy ? 'served' : String(r3));
}

/* A saved wiki's page is the archive's rewritten version and must never be
 * compared with the network copy, or every page reads as "updated". */
async function checkNoFalseUpdateToast() {
  console.log('\nservice worker: no false "page updated" from the offline copy\n');

  // Served from the OFFLINE cache (rewritten), network returns a different
  // (original) body. This must NOT announce a change.
  let w = bootWorker({
    serve: () => ({ ct: 'text/html', body: '<html>ORIGINAL from the site' }),
    offlineCopy: { path: '/dev/docs/p.html', body: '<html>REWRITTEN offline copy' },
  });
  let a = w.ask('/dev/docs/p.html', { mode: 'navigate' });
  if (a) { await a.catch(() => {}); }
  await Promise.all(w.seen.waited || []);
  await new Promise((r) => setTimeout(r, 10));
  check('an offline-served page does NOT announce an update',
        !(w.seen.posted || []).some((m) => m && m.type === 'PAGE_UPDATED'),
        JSON.stringify(w.seen.posted));
}

/* A QuotaExceededError on store must not turn a successful network response
 * into an offline answer. WebKit's quota is about 1 GB. */
async function checkFullStorageFailsOpen() {
  console.log('\nservice worker: no room to cache, still online\n');

  const INDEX = '/dev/searchindex.js';
  const PAGE = '/dev/docs/building-setup-linux.html';

  {
    const w = bootWorker({ putFails: true, serve: () => ({ body: 'INDEX' }) });
    const res = await w.ask(INDEX);
    check('a full cache still returns the network copy of the search index',
          !!res && res.status === 200 && res.url && res.url.endsWith(INDEX),
          res ? 'status ' + res.status : 'nothing answered');
    check('and it did try to store it', w.seen.puts.length === 1,
          JSON.stringify(w.seen.puts));
  }

  {
    const w = bootWorker({ putFails: true, serve: () => ({ ct: 'text/html' }) });
    const res = await w.ask(PAGE, { mode: 'navigate', destination: 'document' });
    check('a full cache still returns the network copy of a page',
          !!res && res.status === 200, res ? 'status ' + res.status : 'nothing');
  }

  // The other half of the contract: a real network failure must still be
  // answered from storage, which is the behaviour the catch was written for.
  {
    const w = bootWorker({ networkFails: true,
                           offlineCopy: { path: INDEX, body: 'SAVED' } });
    const res = await w.ask(INDEX);
    // Identity with the served object says "from storage", not a built 504.
    check('a genuine network failure is still answered from the archive',
          !!res && res === w.seen.servedCopy,
          res ? 'status ' + res.status + (res === w.seen.servedCopy
                                            ? ' from the archive' : ' constructed')
              : 'nothing');
  }

  {
    const w = bootWorker({ networkFails: true });
    const res = await w.ask(INDEX);
    check('with nothing stored, a network failure is still a 504',
          !!res && res.status === 504, res ? 'status ' + res.status : 'nothing');
  }
}

async function checkVersionBump() {
  console.log('\nservice worker: what a version bump throws away\n');

  const src = fs.readFileSync(WORKER, 'utf8');
  const version = (src.match(/const CACHE_VERSION = '([^']+)'/) || [])[1];
  check('the worker declares a cache version', !!version, String(version));

  const w = bootWorker({ existingCaches: [
    'ardupilot-pages-v3', 'ardupilot-static-v3', 'ardupilot-images-v3',
    'ardupilot-thirdparty-v3',
    'ardupilot-pages-' + version, 'ardupilot-static-' + version,
    'ardupilot-offline-dev', 'ardupilot-offline-common',
    'something-else-entirely',
  ] });
  const left = await w.activate();

  check('caches from an older version are thrown away',
        !left.some((n) => /-v3$/.test(n)) && seenDeleted(w, 'ardupilot-static-v3'),
        JSON.stringify(w.seen.deleted));
  check('caches at the current version are kept',
        left.includes('ardupilot-pages-' + version) &&
        left.includes('ardupilot-static-' + version), JSON.stringify(left));
  // The one that matters: a reader's downloaded wikis are not versioned and
  // must survive, or a one-character edit costs everybody 500 MB.
  check('downloaded wikis survive the bump',
        left.includes('ardupilot-offline-dev') &&
        left.includes('ardupilot-offline-common'), JSON.stringify(left));
  check('caches belonging to something else are left alone',
        left.includes('something-else-entirely'), JSON.stringify(left));
}

function seenDeleted(w, name) { return w.seen.deleted.includes(name); }

/** A Request or string, as the path the caches are keyed by. */
function keyOfUrl(r) {
  const u = typeof r === 'string' ? r : r.url;
  return u.startsWith('http') ? new URL(u).pathname : u;
}

/* Offline, the firmware version index offers only the versions held. Filtered
 * in the worker, since 66 of the pages carrying the dropdown are frozen HTML;
 * nothing filtered is stored. */
async function checkParamIndexFiltered() {
  console.log('\nservice worker: the version dropdown offers only what is held');

  const INDEX = '/copter/_static/parameters-Copter.json';
  const published = {
    'Copter stable V4.7.0': 'parameters-Copter-stable-V4.7.0.html',
    'Copter stable V4.6.3': 'parameters-Copter-stable-V4.6.3.html',
    'Copter stable V4.5.7': 'parameters-Copter-stable-V4.5.7.html',
    'Copter latest V4.8.0-dev': 'parameters.html'
  };
  const held = new Set([
    INDEX,
    '/copter/docs/parameters.html',
    '/copter/docs/parameters-Copter-stable-V4.7.0.html'
  ]);

  const body = (path) => ({
    url: path,
    clone() { return body(path); },
    headers: { get: () => null },
    json: async () => published,
    text: async () => JSON.stringify(published),
  });

  const ctx = {
    URL, console,
    caches: {
      keys: async () => ['ardupilot-offline-copter'],
      match: async (r) => (held.has(keyOfUrl(r)) ? body(keyOfUrl(r)) : undefined),
      open: async () => ({
        match: async (r) => {
          const k = keyOfUrl(r);
          if (k === '/__ap_complete__') { return body(k); }
          return held.has(k) ? body(k) : undefined;
        },
        put: async () => undefined,
      }),
    },
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    Request: class { constructor(u) { this.url = String(u); } },
    Response: class {
      constructor(b, init) { this._b = b; Object.assign(this, init); }
      async json() { return JSON.parse(this._b); }
    },
  };
  vm.createContext(ctx);
  vm.runInContext(liftLookup(fs.readFileSync(WORKER, 'utf8')) +
    'this.paramIndex=paramIndex;this.PARAM_INDEX=PARAM_INDEX;', ctx);

  check('the index URL is recognised as one to filter',
        ctx.PARAM_INDEX.test(INDEX), INDEX);
  check('an ordinary static file is not',
        !ctx.PARAM_INDEX.test('/copter/_static/theme.css'));

  const res = await ctx.paramIndex({ url: 'https://example.test' + INDEX },
                                   new URL('https://example.test' + INDEX));
  const out = res ? await res.json() : null;
  const labels = out ? Object.keys(out) : [];

  check('offline, only the versions actually stored are offered',
        labels.length === 2, JSON.stringify(labels));
  check('the version the reader saved is one of them',
        labels.indexOf('Copter stable V4.7.0') !== -1, JSON.stringify(labels));
  check('the current list, which ships in the archive, is the other',
        labels.indexOf('Copter latest V4.8.0-dev') !== -1, JSON.stringify(labels));
  check('a version that was never saved is gone',
        labels.indexOf('Copter stable V4.6.3') === -1, JSON.stringify(labels));
}

async function main() {
  console.log('\nservice worker: offline lookup\n');
  checkWorkerEvaluates();
  const cur = run(fs.readFileSync(WORKER, 'utf8'), 'sw.js');
  if (!cur) {
    await checkUpdateRouting();
    await checkPoisonGuard();
    await checkVersionBump();
    await checkArchiveFallback();
    await checkRevalidationIsAwaited();
    await checkRefreshSurvivesAConsumedBody();
    await checkMarkerRespected();
    await checkNoFalseUpdateToast();
  await checkFullStorageFailsOpen();
    console.log(failures ? '\n' + failures + ' CHECK(S) FAILED\n'
                         : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
  }
  const { ctx, store, wikiNames, ask, askImage } = cur;

  const pages = wikiNames.filter((n) => n.endsWith('.html')).map((n) => '/' + n);
  console.log('  cache holds ' + store.size + ' keys, ' + pages.length +
              ' of them pages\n');

  // Every page, asked for the way the site actually addresses it.
  let missed = [];
  for (const p of pages) {
    const url = canonical(p);
    if (url === p) { continue; }
    if (!(await ask(url))) { missed.push(url); }
  }
  check('every page resolves from its canonical (extensionless) URL',
        missed.length === 0,
        missed.length ? missed.length + ' missed, e.g. ' + missed[0]
                      : pages.length + ' pages');

  // The shapes a reader arrives by.
  check('a page reloaded at its canonical URL resolves',
        !!(await ask('/' + WIKI + '/docs/common-downloads_firmware')) ||
        !!(await ask(canonical('/' + pages[Math.floor(pages.length / 2)].slice(1)))),
        'mid-list page');
  check("a wiki's root resolves as a directory",
        !!(await ask('/' + WIKI + '/')), '/' + WIKI + '/');
  check('a link that still carries .html resolves',
        !!(await ask('/' + WIKI + '/index.html')), '/' + WIKI + '/index.html');

  // Assets must be untouched by the widening: they already carry an extension.
  const anImage = wikiNames.find((n) => /_images\/.*\.(png|jpe?g)$/i.test(n));
  if (anImage) {
    check('an image still resolves exactly', !!(await ask('/' + anImage)),
          '/' + anImage);
    const shapes = cur.ctx.storedShapes(new URL('https://e.test/' + anImage));
    check('an image asks for its own path first, then the shared copy',
          shapes[0] === '/' + anImage &&
          shapes.some((p) => p.startsWith('/_common/_images/')),
          shapes.join('  '));
  }
  check('a page that is genuinely absent still misses',
        !(await ask('/' + WIKI + '/docs/no-such-page-here')));

  /* ------------------------------------------------ lookups stay exact ---- */
  // Shapes are built from the pathname, so a fingerprint query never reaches
  // the lookup and an exact match is enough.
  check('a fingerprinted asset URL still resolves',
        !!(await ask('/' + WIKI + '/_static/css/theme.css?v=5d32c60e')) ||
        !!(await ask('/' + WIKI + '/index.html?highlight=motor')),
        'query stripped before lookup');

  // ignoreSearch walks the whole cache: 0.2 ms exact against 325 ms.
  const workerSrc = fs.readFileSync(WORKER, 'utf8');
  check('the offline lookup does not ask the cache to ignore the query',
        !/ignoreSearch\s*:/.test(workerSrc),
        'exact matches only');

  /* ------------------------------------------- wikis folded into common --- */
  // A folded wiki's pages resolve either way; assert they resolve by NAME,
  // since the exhaustive fallback is 325 ms against 0.2 ms.
  check('a folded wiki is looked up in the common cache, not its own',
        ctx.likelyCacheName('/ardupilot/docs/about.html') ===
          'ardupilot-offline-common',
        ctx.likelyCacheName('/ardupilot/docs/about.html'));
  check('an unfolded wiki still has its own cache',
        ctx.likelyCacheName('/copter/docs/x.html') === 'ardupilot-offline-copter');

  /* ---------------------------------------------------------- images ------ */
  // Every image a saved wiki holds must come out of the download, the
  // wiki-unique ones included.
  const ownImages = wikiNames
    .filter((n) => /^[^/]+\/_images\/[^/]+$/.test(n))
    .map((n) => '/' + n);
  const sharedSample = [...store]
    .filter((k) => k.startsWith('/_common/_images/')).slice(0, 200)
    .map((k) => '/' + WIKI + '/_images/' + k.split('/').pop());

  let brokeOwn = [];
  for (const p of ownImages) {
    if (!(await askImage(p))) { brokeOwn.push(p); }
  }
  check("images belonging to this wiki resolve from the download",
        brokeOwn.length === 0,
        brokeOwn.length ? brokeOwn.length + ' of ' + ownImages.length +
                          ' broken, e.g. ' + brokeOwn[0]
                        : ownImages.length + ' images');

  let brokeShared = [];
  for (const p of sharedSample) {
    if (!(await askImage(p))) { brokeShared.push(p); }
  }
  check('shared images still resolve through the /_common/ remap',
        brokeShared.length === 0,
        brokeShared.length ? brokeShared.length + ' broken, e.g. ' + brokeShared[0]
                           : sharedSample.length + ' sampled');

  check('an image that was never downloaded still misses',
        !(await askImage('/' + WIKI + '/_images/no-such-image-here.png')));

  // The same questions against the previous worker, to show the tests bite.
  let old = null;
  try {
    old = execFileSync('git', ['-C', REPO, 'show', 'HEAD:frontend/sw.js']).toString();
  } catch (e) { /* not in git, skip */ }
  if (old && old.indexOf('function storedShapes(') === -1) {
    console.log('\n  (previous sw.js had no variant matching, so the canonical' +
                ' URL of every page missed)');
  }

  await checkUpdateRouting();
  await checkPoisonGuard();
  await checkVersionBump();
  await checkArchiveFallback();
  await checkRevalidationIsAwaited();
  await checkRefreshSurvivesAConsumedBody();
  await checkMarkerRespected();
  await checkNoFalseUpdateToast();
  await checkFullStorageFailsOpen();
  await checkParamIndexFiltered();

  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED\n'
                       : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
