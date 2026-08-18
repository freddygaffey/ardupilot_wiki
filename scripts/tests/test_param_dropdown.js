/*
 * B1: the firmware version dropdown must not offer what a reader cannot reach.
 *
 *   node scripts/tests/test_param_dropdown.js
 *
 * The dropdown is upstream's and lists every version the build produced. The
 * archive holds only the versions a reader ticked, so offline the rest lead to
 * the offline fallback. Measured before the fix: fifteen offered, six followed,
 * five dead ends.
 *
 * This drives the real module against a real select, with a real Cache Storage
 * shim, in the three states that matter: never saved, saved and online, saved
 * and offline.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.resolve(__dirname, '..', '..');
const MODULE = path.join(REPO, 'common/source/_static/common_offline_params.js');

let pass = 0, fail = 0;
const failed = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

const VERSIONS = ['4.7.0', '4.6.3', '4.6.2', '4.6.1', '4.5.7'];

/** Cache Storage holding exactly `held` (paths), plus a marker if `saved`. */
function fakeCaches(held, saved) {
  const store = new Set(held);
  const cache = {
    match: (k) => Promise.resolve(
      (k === '/__ap_complete__' && saved) ? { ok: true } : undefined),
  };
  return {
    open: () => Promise.resolve(cache),
    match: (k) => Promise.resolve(store.has(String(k)) ? { ok: true } : undefined),
  };
}

async function run({ saved, online, held }) {
  const options = VERSIONS.map((v) =>
    `<option value="parameters-Copter-stable-V${v}.html">Copter stable V${v}</option>`).join('');
  const dom = new JSDOM(
    `<body><select id="selectPicker">${options}</select></body>`,
    { url: 'https://ardupilot.org/copter/docs/parameters.html',
       // window.eval needs a real window as its global, or the module cannot
       // see the window and document it is written against.
       runScripts: 'outside-only' });
  const w = dom.window;
  w.caches = fakeCaches(held.map((v) => `/copter/docs/parameters-Copter-stable-V${v}.html`), saved);
  Object.defineProperty(w.navigator, 'onLine', { value: online, configurable: true });

  // Run the shipped module inside the page, as the <script> tag does, so it
  // sees the real window, document and navigator rather than stand-ins.
  w.eval(fs.readFileSync(MODULE, 'utf8'));
  for (let i = 0; i < 20; i++) { await new Promise((r) => setImmediate(r)); }

  const sel = w.document.getElementById('selectPicker');
  return [...sel.options].map((o) => ({ text: o.text, disabled: o.disabled }));
}

(async () => {
  console.log('\na reader who has never saved this wiki sees no change');
  {
    const opts = await run({ saved: false, online: false, held: [] });
    check('no option is relabelled',
          opts.every((o) => !/not saved/.test(o.text)),
          JSON.stringify(opts.map((o) => o.text)));
    check('no option is disabled', opts.every((o) => !o.disabled));
  }

  console.log('\nsaved, and online: everything still reachable, so nothing is disabled');
  {
    const opts = await run({ saved: true, online: true, held: ['4.7.0'] });
    check('versions not saved are labelled, so the reader knows',
          opts.filter((o) => /not saved/.test(o.text)).length === 4,
          JSON.stringify(opts.map((o) => o.text)));
    check('but nothing is disabled, because online they all work',
          opts.every((o) => !o.disabled));
    check('the saved version is not labelled',
          !/not saved/.test(opts.find((o) => o.text.indexOf('4.7.0') !== -1).text));
  }

  console.log('\nsaved, and offline: the four that would dead-end are disabled');
  {
    const opts = await run({ saved: true, online: false, held: ['4.7.0'] });
    const dead = opts.filter((o) => o.disabled).map((o) => o.text);
    check('every version that is not stored is disabled', dead.length === 4,
          JSON.stringify(dead));
    check('the one the reader actually saved stays selectable',
          !opts.find((o) => o.text.indexOf('4.7.0') !== -1).disabled);
    check('and it is not labelled as missing',
          !/not saved/.test(opts.find((o) => o.text.indexOf('4.7.0') !== -1).text));
  }

  console.log('\na version read while browsing counts as held, not just a download');
  {
    const opts = await run({ saved: true, online: false, held: ['4.7.0', '4.6.2'] });
    check('a page stored by being visited is reachable and stays enabled',
          !opts.find((o) => o.text.indexOf('4.6.2') !== -1).disabled,
          JSON.stringify(opts.filter((o) => o.disabled).map((o) => o.text)));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('failed: ' + failed.join('; ')); }
  process.exit(fail ? 1 : 0);
})();
