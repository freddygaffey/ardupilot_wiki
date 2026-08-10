/*
 * Verification harness for the service worker's offline lookup.
 *
 *   node scripts/tests/test_offline_worker.js [wiki]
 *
 * The archives store what Sphinx built - /rover/docs/foo.html - while
 * Cloudflare Pages canonicalises the site so the address a reader is actually
 * on is /rover/docs/foo. Nothing in the existing tests compared those two, so
 * an exact-match lookup passed every test and failed every reader: pages
 * resolved only while clicking links that still carried the extension, and a
 * reload or a cold open fell through to the offline page.
 *
 * So this builds a cache from the real archive entry names, asks for the URLs
 * the site really serves, and uses the worker's own matching code to answer.
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

/**
 * Lift the lookup out of sw.js and run it here.
 *
 * Importing the worker is not possible - it registers event listeners against
 * a ServiceWorkerGlobalScope that does not exist here - so the two functions
 * that decide whether a page is held are taken by name, the same way the
 * export tests take theirs. A copy in this file would be a copy that can agree
 * with itself while the shipped worker is wrong.
 */
function liftLookup(src) {
  let out = '';
  // Module-level state the matcher consults, taken with it.
  for (const re of [/const ASSET_EXT_RE\s*=\s*[\s\S]*?;/,
                    /const OFFLINE_CACHE_PREFIX\s*=\s*[^;]*;/,
                    /let knownCacheNames\s*=\s*[^;]*;/,
                    /const openedCaches\s*=\s*[^;]*;/]) {
    const m = src.match(re);
    if (m) { out += m[0] + '\n'; }
  }
  for (const name of ['storedShapes', 'likelyCacheName', 'offlineCacheFor',
                      'heldOffline', 'cacheFirst']) {
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
    console.log('  (no archives built; run update.py --offline first)');
    return;
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

  // IMAGE_CACHE starts empty: that is a reader who downloaded a wiki and then
  // went offline without having browsed it online first, which is the whole
  // point of downloading.
  const runtimeCache = new Map();

  // A Response-shaped stub. It returned a bare { url } before, so the moment
  // the worker did anything a real Response supports - cloning one before
  // putting it in a cache - the harness threw where the browser would not.
  // A test that cannot survive correct code is worse than no test.
  const asResponse = (path) => ({
    url: path,
    clone() { return asResponse(path); },
    text: async () => '',
  });

  const ctx = {
    URL,
    console,
    caches: {
      match: async (r) => (store.has(keyOf(r)) ? asResponse(keyOf(r)) : undefined),
      // Every offline cache a reader would hold, so the named-cache path is
      // exercised rather than silently falling through to the exhaustive one.
      keys: async () => [...new Set([...store].filter((k) => k.startsWith('/'))
        .map((k) => k.startsWith('/_common/')
          ? 'ardupilot-offline-common'
          : 'ardupilot-offline-' + k.split('/')[1]))],
      open: async (name) => ({
        match: async (r) => {
          const k = keyOf(r);
          if (typeof name === 'string' && name.startsWith('ardupilot-offline-')) {
            const want = k.startsWith('/_common/')
              ? 'ardupilot-offline-common'
              : 'ardupilot-offline-' + k.split('/')[1];
            if (want !== name) { return undefined; }
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
    'this.cacheFirst=cacheFirst;', ctx);

  const ask = (u) => ctx.heldOffline({ url: 'https://example.test' + u });
  const askImage = async (u) => {
    const r = await ctx.cacheFirst({ url: 'https://example.test' + u }, 'images');
    return r && r.url ? r : undefined;
  };

  return { ctx, store, wikiNames, ask, askImage };
}

/**
 * The URL Cloudflare Pages serves a built file as. Verified against the live
 * demo: /x.html 308s to /x, and /index.html to the directory.
 */
function canonical(p) {
  if (p.endsWith('/index.html')) { return p.slice(0, -'index.html'.length); }
  return p.replace(/\.html$/, '');
}

/**
 * The worker must actually evaluate, not merely parse.
 *
 * node --check validates syntax and nothing more, so a const used above its
 * own declaration passes it and then fails in the browser with "ServiceWorker
 * script evaluation failed" - which registers as nothing at all: no caching,
 * no offline, no error on the page. That shipped once, from CURRENT_CACHES
 * referencing a cache name declared five lines below it.
 */
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

async function main() {
  console.log('\nservice worker: offline lookup\n');
  checkWorkerEvaluates();
  const cur = run(fs.readFileSync(WORKER, 'utf8'), 'sw.js');
  if (!cur) { process.exit(failures ? 1 : 0); }
  const { store, wikiNames, ask, askImage } = cur;

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

  /* ---------------------------------------------------------- images ------ */
  // With the network down and nothing browsed beforehand, every image a
  // downloaded wiki holds has to come out of the download. Images unique to
  // one wiki are the ones that were missing: the shared set resolved through
  // the /_common/ remap, so most pictures appeared and the rest did not.
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

  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED\n'
                       : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
