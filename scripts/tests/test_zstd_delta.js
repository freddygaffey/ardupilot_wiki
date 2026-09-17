#!/usr/bin/env node
/**
 * The vendored zstd decoder rebuilds a page from a delta and its base, and
 * refuses a delta that does not fit. The fixture delta was written by the
 * Python zstandard library the build uses, so this also proves the two
 * tools agree on the format.
 *
 *   node scripts/tests/test_zstd_delta.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) { failures++; }
}

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(__dirname, 'fixtures');

/** The decoder as a plain script, the way a page or worker gets it. */
function loadDecoder() {
  const sandbox = { WebAssembly, console, TextDecoder, TextEncoder, Uint8Array, Promise, setTimeout, clearTimeout };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'zstd-delta.js'), 'utf8'), sandbox);
  return sandbox.ApZstd;
}

(async () => {
  console.log('\nzstd delta: rebuild a page from its delta and base\n');
  const ApZstd = loadDecoder();
  check('the script defines ApZstd with init and patch',
        ApZstd && typeof ApZstd.init === 'function' && typeof ApZstd.patch === 'function');
  const wasm = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'zstd.wasm'));
  const mode = await ApZstd.init(new Uint8Array(wasm).buffer);
  check('init resolves from an ArrayBuffer, as the worker loads it from cache, in wasm mode',
        mode === 'wasm' && ApZstd.mode() === 'wasm', String(mode));

  const base = new Uint8Array(fs.readFileSync(path.join(FIX, 'delta-base.html')));
  const page = fs.readFileSync(path.join(FIX, 'delta-page.html'));
  const delta = new Uint8Array(fs.readFileSync(path.join(FIX, 'delta-page.zst')));

  const out = ApZstd.patch(delta, base);
  check('a Python-built delta applied to its base gives the page byte for byte',
        Buffer.compare(Buffer.from(out), page) === 0, out.length + ' bytes');
  check('the delta is a fraction of the page', delta.length * 10 < page.length,
        delta.length + ' vs ' + page.length);

  let threw = null;
  try { ApZstd.patch(delta, base.subarray(0, base.length - 1000)); } catch (e) { threw = e.message; }
  check('a wrong base is refused rather than yielding a corrupt page', !!threw, threw || 'no error');

  threw = null;
  try { ApZstd.patch(delta.subarray(0, delta.length - 8), base); } catch (e) { threw = e.message; }
  check('a truncated delta is refused', !!threw, threw || 'no error');

  // Twice in a row, so freed memory is really freed.
  const again = ApZstd.patch(delta, base);
  check('a second patch on the same decoder is identical', Buffer.compare(Buffer.from(again), page) === 0);

  console.log('\nthe JavaScript decoder, for a browser without WebAssembly\n');
  const js = loadDecoder();
  check('init(null) chooses JavaScript outright', (await js.init(null)) === 'js' && js.mode() === 'js');
  const t0 = process.hrtime.bigint();
  const jsOut = js.patch(delta, base);
  const jsMs = Number(process.hrtime.bigint() - t0) / 1e6;
  check('the JavaScript decoder rebuilds the same page byte for byte',
        Buffer.compare(Buffer.from(jsOut), page) === 0, jsOut.length + ' bytes in ' + jsMs.toFixed(0) + ' ms');
  // fzstd carries no checksum, so a wrong base yields a wrong page rather
  // than an error; that is why every delta header carries the page's hash.
  let wrong = null;
  try { wrong = js.patch(delta, base.subarray(0, base.length - 1000)); } catch (e) { wrong = null; }
  check('a wrong base never yields the right page in JavaScript, so the hash check must stand',
        wrong === null || Buffer.compare(Buffer.from(wrong), page) !== 0);
  const big = fs.readFileSync(path.join(FIX, 'param-delta-page.zst'));
  const bigBase = new Uint8Array(fs.readFileSync(path.join(FIX, 'param-delta-base.html')));
  check('and agrees with the wasm decoder on a second fixture',
        Buffer.compare(Buffer.from(js.patch(big, bigBase)), Buffer.from(ApZstd.patch(big, bigBase))) === 0);

  const broken = loadDecoder();
  const fell = await broken.init(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer);
  check('a wasm that will not load falls back to JavaScript instead of failing',
        fell === 'js' && Buffer.compare(Buffer.from(broken.patch(delta, base)), page) === 0, String(fell));

  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED\n' : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
