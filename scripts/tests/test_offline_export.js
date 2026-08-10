/*
 * Verification harness for the browser-side exporters.
 *
 *   node scripts/tests/test_offline_export.js [wiki...]
 *
 * common/source/_static/offline-export.js builds the single-file .html from Cache
 * Storage. Every bug it has had so far - images resolved to paths that match
 * nothing, the same image written once per page, a sidebar that nested each
 * wiki inside the last - looked fine from the outside and only showed up when
 * something opened the result. So this runs the real exporter against a cache
 * built from real build output, and checks the bytes it produces.
 *
 * The browser APIs it needs are shimmed rather than mocked away: a real
 * CacheStorage-alike over the filesystem, and the exporter is given a sink so
 * output lands in a file instead of a download.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..');
const ARGS = process.argv.slice(2);
const FULL = ARGS.includes('--full');
// --full loads every wiki with no page cap, to measure a real export rather
// than a sample. Slow and memory-hungry; the default stays small.

// The sidebar, page index and image index are shared across wikis, so a
// single-wiki run exercises none of them. Two small wikis take seconds.
const WIKIS_ARG = ARGS.filter((a) => !a.startsWith('--'));
const WIKI = WIKIS_ARG[0] || 'rover';
const ALL_WIKIS = ['copter', 'plane', 'rover', 'sub', 'blimp', 'dev',
                   'antennatracker', 'planner', 'planner2', 'ardupilot', 'mavproxy'];
const OUT = '/tmp/ap-export-test';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) { failures++; }
}

/* ---------------------------------------------------------- cache shim ---- */

class FakeResponse {
  constructor(buf) { this._buf = buf; }
  arrayBuffer() { return Promise.resolve(this._buf.buffer.slice(
    this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength)); }
  text() { return Promise.resolve(this._buf.toString('utf8')); }
}

class FakeCache {
  constructor() { this.map = new Map(); }
  put(url, res) { this.map.set(String(url), res); return Promise.resolve(); }
  keys() {
    return Promise.resolve([...this.map.keys()].map((u) => ({ url: 'https://x' + u })));
  }
  match(req) {
    const url = typeof req === 'string' ? req : req.url.replace('https://x', '');
    return Promise.resolve(this.map.get(url));
  }
}

const caches = {
  _all: new Map(),
  keys() { return Promise.resolve([...this._all.keys()]); },
  open(name) {
    if (!this._all.has(name)) { this._all.set(name, new FakeCache()); }
    return Promise.resolve(this._all.get(name));
  }
};

/** Populate the cache the way a real download would: wiki pages + shared images. */
function loadWiki(wiki, limit) {
  const root = path.join(REPO, wiki, 'build', 'html');
  if (!fs.existsSync(root)) {
    console.error('No build output for ' + wiki + ' - run update.py --site ' + wiki);
    process.exit(2);
  }
  const wikiCache = new FakeCache();
  const commonCache = caches._all.get('ardupilot-offline-common') || new FakeCache();
  let pages = 0, images = 0, css = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const rel = '/' + wiki + '/' + path.relative(root, full).split(path.sep).join('/');
      const buf = fs.readFileSync(full);

      if (rel.endsWith('.html')) {
        var isIndex = /\/index\.html$/.test(rel);
        if (pages >= limit && !isIndex) { continue; }
        pages++;
        wikiCache.put(rel, new FakeResponse(buf));
      } else if (/\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot)$/i.test(rel)) {
        // Mirror production: shared images live once under /_common/.
        if (rel.includes('/_images/')) {
          if (images >= limit * 3) { continue; }
          images++;
          commonCache.put(rel.replace(/^\/[^/]+\/_images\//, '/_common/_images/'),
                          new FakeResponse(buf));
        } else {
          wikiCache.put(rel, new FakeResponse(buf));
        }
      } else if (rel.endsWith('.css') || rel.endsWith('.js')) {
        css++;
        wikiCache.put(rel, new FakeResponse(buf));
      }
    }
  };
  walk(root);

  wikiCache.put('/__ap_complete__',
    new FakeResponse(Buffer.from(JSON.stringify({ build: 'test', id: wiki }))));
  commonCache.put('/__ap_complete__',
    new FakeResponse(Buffer.from(JSON.stringify({ build: 'test', id: 'common' }))));

  caches._all.set('ardupilot-offline-' + wiki, wikiCache);
  caches._all.set('ardupilot-offline-common', commonCache);
  return { pages, images, css };
}

/* --------------------------------------------------------- module load ---- */

function loadExporter() {
  const src = fs.readFileSync(
    path.join(REPO, 'common/source/_static/offline-export.js'), 'utf8');
  const sandbox = {
    caches,
    TextEncoder, TextDecoder, URL, btoa, console,
    setTimeout, clearTimeout,
    navigator: {},                 // no service worker: forces the sink we pass
    document: { createElement: () => ({ style: {}, click() {}, remove() {} }),
                body: { appendChild() {} } },
    Blob: class { constructor(p) { this.parts = p; } },
    window: {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.ArduPilotExport;
}

/** A sink that writes straight to a file, standing in for the download. */
function fileSink(target) {
  const fd = fs.openSync(target, 'w');
  return {
    write(chunk) { fs.writeSync(fd, Buffer.from(chunk)); return Promise.resolve(); },
    close() { fs.closeSync(fd); return Promise.resolve(); }
  };
}

/**
 * Count patterns and look for literals in a file too large to hold as a string.
 *
 * Chunks overlap so a match spanning a boundary is not missed.
 */
function scanFile(file, patterns, literals) {
  const counts = patterns.map(() => 0);
  const found = {};
  literals.forEach((l) => { found[l] = false; });

  const SIZE = 8 * 1024 * 1024;
  const OVERLAP = 4096;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(SIZE);
  let carry = '';
  let bytes;
  while ((bytes = fs.readSync(fd, buf, 0, SIZE, null)) > 0) {
    const text = carry + buf.slice(0, bytes).toString('latin1');
    patterns.forEach((re, i) => {
      re.lastIndex = 0;
      const m = text.match(re);
      counts[i] += m ? m.length : 0;
    });
    literals.forEach((l) => { if (!found[l] && text.includes(l)) { found[l] = true; } });
    carry = text.slice(-OVERLAP);
  }
  fs.closeSync(fd);
  return { counts, found };
}

/**
 * The JSON the shell routes from, read back out of the finished file. It is
 * written last, so the tail holds it however large the export is.
 */
function readIndexPayload(file) {
  const size = fs.statSync(file).size;
  const span = Math.min(size, 64 * 1024 * 1024);
  const buf = Buffer.alloc(span);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, span, size - span);
  fs.closeSync(fd);
  const tail = buf.toString('utf8');
  const m = tail.match(
    /<script type="application\/json" id="ap-index">([\s\S]*?)<\/script>/);
  if (!m) { return null; }
  try { return JSON.parse(m[1].split('<\\/').join('</')); } catch (e) { return null; }
}

/** The shipped search index and the stemmer that built it, read back out. */
function readSearchPayload(file) {
  const size = fs.statSync(file).size;
  const span = Math.min(size, 96 * 1024 * 1024);
  const buf = Buffer.alloc(span);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, span, size - span);
  fs.closeSync(fd);
  const m = buf.toString('utf8')
    .match(/<script type="application\/json" id="ap-fts">([\s\S]*?)<\/script>/);
  if (!m) { return null; }
  try { return JSON.parse(m[1].split('<\\/').join('</')); } catch (e) { return null; }
}

// Sphinx's own stemmer and stopword list, loaded from the build output.
let stemWord = (w) => w, STOPWORDS = [];
(function () {
  const p = path.join(REPO, 'rover', 'build', 'html', '_static', 'language_data.js');
  if (!fs.existsSync(p)) { return; }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(p, 'utf8'), ctx);
  if (ctx.Stemmer) { const s = new ctx.Stemmer(); stemWord = (w) => s.stemWord(w); }
  if (ctx.stopwords) { STOPWORDS = ctx.stopwords; }
})();

const EXPORTER = path.join(REPO, 'common/source/_static/offline-export.js');

/**
 * Lift named functions out of the exporter and run them here.
 *
 * The alternative is a second copy of the logic in this file, and that is
 * precisely how a strict-AND search bug survived a passing test: the copy
 * carried the same defect, so the two agreed with each other and both were
 * wrong. Run the shipped code or do not claim to have tested it.
 */
function liftFunctions(names) {
  const src = fs.readFileSync(EXPORTER, 'utf8');
  let out = '';
  for (const name of names) {
    const at = src.indexOf('function ' + name + '(');
    if (at === -1) { return null; }
    let i = src.indexOf('{', at), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') { depth++; } else if (src[i] === '}') {
        depth--; if (depth === 0) { break; }
      }
    }
    out += src.slice(at, i + 1) + '\n';
  }
  const ctx = {};
  vm.createContext(ctx);
  try {
    vm.runInContext(out + names.map((n) => 'this.' + n + '=' + n + ';').join(''), ctx);
  } catch (e) { return null; }
  return ctx;
}

/**
 * The exporter's own full-text search, lifted out of the shell it writes.
 *
 * SHELL_JS is an array of string literals joined at export time, so the real
 * source is recovered by evaluating the array and slicing out the search
 * block: the same text that ends up inside the .html a reader opens.
 */
function liftSearch(fts) {
  const src = fs.readFileSync(EXPORTER, 'utf8');
  const s = src.indexOf('var SHELL_JS = [');
  const e = src.indexOf("].join('')", s);
  if (s === -1 || e === -1) { return null; }
  let shell;
  try {
    shell = vm.runInNewContext(src.slice(src.indexOf('[', s), e + 1) + ".join('')");
  } catch (err) { return null; }
  const from = shell.indexOf('var SI=null;');
  const END = 'return out;}';
  const to = shell.indexOf(END, from);
  if (from === -1 || to === -1) { return null; }
  const sandbox = { document: { getElementById: (id) =>
    (id === 'ap-fts' ? { textContent: JSON.stringify(fts) } : null) } };
  vm.createContext(sandbox);
  const lang = path.join(REPO, 'rover', 'build', 'html', '_static', 'language_data.js');
  if (fs.existsSync(lang)) { vm.runInContext(fs.readFileSync(lang, 'utf8'), sandbox); }
  try {
    vm.runInContext(shell.slice(from, to + END.length), sandbox);
  } catch (err) { return null; }
  return typeof sandbox.fullText === 'function'
    ? (q) => sandbox.fullText(q.toLowerCase()) : null;
}

/* ------------------------------------------------------------- the run ---- */

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const wikis = FULL ? ALL_WIKIS.filter((w) =>
    fs.existsSync(path.join(REPO, w, 'build', 'html')))
    : (WIKIS_ARG.length ? WIKIS_ARG : [WIKI]);
  const cap = FULL ? Infinity : 40;

  let totals = { pages: 0, images: 0, css: 0 };
  for (const w of wikis) {
    const r = loadWiki(w, cap);
    totals.pages += r.pages; totals.images += r.images; totals.css += r.css;
  }
  const loaded = totals;
  console.log('\ncache: ' + loaded.pages + ' pages, ' + loaded.images +
              ' shared images, ' + loaded.css + ' stylesheets' +
              (FULL ? '  (' + wikis.length + ' wikis, no cap)' : '') + '\n');

  const api = loadExporter();

  console.log('single-file HTML');
  const htmlPath = path.join(OUT, 'test.html');
  const t0 = Date.now();
  const htmlRes = await api.exportHtml(wikis, 'test.html', null, fileSink(htmlPath));
  console.log('  generated in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  // A full export exceeds V8's maximum string length, so scan it in chunks
  // rather than reading it into one string.
  const scan = scanFile(htmlPath, [
    /id="i\d+"/g, /data-ap-img=/g, /data:image\//g, /@font-face/g,
    /<img[^>]{0,200}src="\.\.\//g
  ], ['.wy-nav-content', 'wy-body-for-nav', 'toctree-l1', '#/' + wikis[0] + '/',
      '#ap-toast.on{display:flex}',
      'if(mapped===null){e.preventDefault();toast(a.href);return;}',
      'go.target="_blank"']);

  const html = { includes: (s) => scan.found[s] };
  const imgBlocks = scan.counts[0];
  const imgRefs = scan.counts[1];
  const inlineDataUris = scan.counts[2];

  check('pages written', htmlRes.pages === loaded.pages,
        htmlRes.pages + ' of ' + loaded.pages);
  check('theme stylesheet embedded', html.includes('.wy-nav-content'));
  check('theme markup emitted', html.includes('wy-body-for-nav'));
  check('fonts inlined', scan.counts[3] > 0, scan.counts[3] + ' rules');
  check('images stored once (no per-page duplication)',
        inlineDataUris <= imgBlocks + 2,
        imgBlocks + ' blocks, ' + imgRefs + ' refs, ' + inlineDataUris + ' data URIs');
  check('images actually resolved', imgBlocks > 0);
  check('navigation from toctree', html.includes('toctree-l1'));

  // Links to other hosts are the one kind that genuinely cannot be routed
  // anywhere, so they used to be followed silently and the reader lost the
  // document. Leaving has to be a decision rather than an accident.
  check('a link to another host raises the toast instead of navigating',
        html.includes('if(mapped===null){e.preventDefault();toast(a.href);return;}'));
  check('the toast is styled', html.includes('#ap-toast.on{display:flex}'));
  check('leaving anyway opens a new tab, keeping the offline copy loaded',
        html.includes('go.target="_blank"'));
  check('path anchors', html.includes('#/' + wikis[0] + '/'));
  check('no unresolved relative image srcs', scan.counts[4] === 0,
        scan.counts[4] + ' left');

  // The sidebar is one element built from every wiki's toctree, so a fragment
  // that does not close its own tags nests each wiki inside the last.
  const D = readIndexPayload(htmlPath);
  check('routing index readable', D !== null && Array.isArray(D.pages));
  if (D) {
    const captions = (D.nav.match(/<p class="caption">/g) || []).length;
    const indexed = [...new Set(D.pages.map((p) => p.p.split('/')[1]))];
    check('every wiki has a sidebar section', captions === wikis.length,
          captions + ' sections for ' + wikis.length + ' wikis');
    check('every wiki has pages in the index', indexed.length === wikis.length,
          indexed.join(', '));
    check('sidebar sections are siblings, not nested',
          !/<div/i.test(D.nav) && !/<form/i.test(D.nav));
    // Under a page cap a sidebar link may legitimately name a page this
    // export does not hold, so resolution can only be asserted on a full run.
    // The shape of the anchor can be asserted either way, and that is where
    // the bug was: a cross-wiki link arriving as /copter/index.html got this
    // wiki prefixed onto it and became #/ardupilot//copter/index, which
    // resolves to nothing whether or not copter is in the file.
    const anchors = (D.nav.match(/href="#([^"]+)"/g) || [])
      .map((h) => h.slice(7, -1)).filter((p) => p.charAt(0) === '/');
    const malformed = anchors.filter(
      (p) => p.indexOf('//') !== -1 || /\.html?$/.test(p));
    check('sidebar anchors are well formed', malformed.length === 0,
          malformed.length ? malformed.slice(0, 3).join('  ')
                           : anchors.length + ' anchors');
    check('sidebar links all point at pages in the file',
          anchors.every((p) => D.pages.some((x) => x.p === p)) || cap !== Infinity,
          cap === Infinity ? '' : '(not checked: page cap in effect)');
    check('image index built', Object.keys(D.imgs || {}).length > 0,
          Object.keys(D.imgs || {}).length + ' image paths');
  }

  // Downloaded archives are the shape this test cannot reach from build/html:
  // rewrite_site_links turns the About wiki's absolute cross-wiki links into
  // paths from the site root, and only an archive carries them. So drive the
  // exporter's own nav rewriting with that shape directly.
  const navFns = liftFunctions(['innerOf', 'topLevelLists', 'extractNav']);
  check('nav helpers lifted from the exporter', navFns !== null);
  if (navFns) {
    const fixture =
      '<div class="wy-menu wy-menu-vertical"><ul>' +
      '<li><a href="docs/common-team.html">Team</a></li>' +
      '<li><a href="/copter/index.html">Copter</a></li>' +
      '<li><a href="/plane/docs/common-choosing-a-ground-station.html">GCSes</a></li>' +
      '<li><a href="https://cloud.ardupilot.org">Drone Engage</a></li>' +
      '</ul></div>';
    const got = (navFns.extractNav(fixture, 'ardupilot').match(/href="([^"]+)"/g) || [])
      .map((h) => h.slice(6, -1));
    check('a link relative to the wiki keeps its wiki',
          got.indexOf('#/ardupilot/docs/common-team') !== -1, got.join('  '));
    check('a cross-wiki link from the site root is not prefixed again',
          got.indexOf('#/copter/index') !== -1, got.join('  '));
    check('no anchor has an empty path segment',
          !got.some((h) => h.indexOf('//') !== -1 && h.charAt(0) === '#'),
          got.join('  '));
    check('a link to another host is left alone',
          got.indexOf('https://cloud.ardupilot.org') !== -1, got.join('  '));
  }

  // Sphinx omits stopwords from its index, so a query containing one must not
  // reduce the result set to nothing. Pasting a sentence used to find nothing
  // at all.
  const fts = readSearchPayload(htmlPath);
  const search = fts ? liftSearch(fts) : null;
  check('search lifted from the exporter', !fts || search !== null);
  if (search) {
    const probe = (q) => Object.keys(search(q)).length;
    const bare = probe('vehicle');
    check('full-text search finds a word in body text', bare > 0, bare + ' docs');
    check('a stopword in the query does not empty the results',
          probe('the vehicle') === bare, probe('the vehicle') + ' vs ' + bare);
    check('a whole pasted sentence still matches',
          probe('the vehicle is a copter') > 0, probe('the vehicle is a copter') + ' docs');

    // Requiring every word to match meant one unmatchable word answered
    // "nothing found" however much of the query pointed somewhere. A reader
    // dragging a selection clips the first and last words, so this is what
    // pasting a sentence actually looks like.
    check('a word that matches nothing does not empty the results',
          probe('vehicle zzzznotaword') === bare,
          probe('vehicle zzzznotaword') + ' vs ' + bare);

    // The real report: "industrial-grade" arrived as "rial-grade", which
    // matches other pages by one edit and the intended page not at all.
    const CLIPPED = 'rial-grade, dual-band GNSS module designed and ' +
      'manufactured in India by TeraVolt Labs. It is specifically engineered ' +
      'to support the NavIC (IRNSS) constellation, making it fully compliant ' +
      'with DGCA requirements for indigenous dron';
    const hasPage = Object.keys(fts).some(
      (w) => (fts[w].docnames || []).some((n) => /AeroNav-1/i.test(n)));
    if (hasPage) {
      const hits = Object.keys(search(CLIPPED));
      check('a sentence clipped mid-word by the selection still finds its page',
            hits.some((p) => /AeroNav-1/i.test(p)),
            hits.length + ' hits: ' + (hits.slice(0, 3).join(', ') || 'none'));
    }
  }

  console.log('\nwrote ' + OUT + '/test.html');
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED\n' : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
