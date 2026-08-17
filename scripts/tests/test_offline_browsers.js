/*
 * Does the wiki actually read offline, in a real browser, in every engine?
 *
 *   node scripts/tests/test_offline_browsers.js
 *   node scripts/tests/test_offline_browsers.js --browsers chromium,webkit
 *   node scripts/tests/test_offline_browsers.js --headed --keep
 *
 * The other tests in this directory run the worker's logic under node, which
 * proves the lookup is right and proves nothing about whether a browser hands
 * the navigation to the worker at all. That is a real gap: everything here is
 * only ever exercised by Chrome on one laptop, while Safari and Firefox have
 * their own storage limits, their own service worker lifetimes, and their own
 * rules about which navigations reach a worker.
 *
 * HOW "OFFLINE" IS DONE, AND WHY NOT setOffline
 *
 * Playwright's context.setOffline drops the *page's* requests. Requests the
 * service worker makes are a separate network agent, and outside Chromium they
 * are not covered - so a worker that quietly went to the network would still
 * pass. This serves the built tree from a local server and then STOPS THE
 * SERVER. Every engine is then genuinely offline for that origin, with no
 * emulation involved and nothing to be wrong about.
 *
 * WHAT IT DOES NOT COVER
 *
 * Downloading an archive: `common` is 439 MB and required, which is minutes per
 * engine and gigabytes of disk. This covers the read-as-you-browse path, which
 * is the one every reader gets for free. Storage headroom for the archive path
 * is reported per engine instead - see the quota check.
 */

'use strict';

const path = require('path');
const { start, bumpWorker } = require('./serve_wiki_tree');

const REPO = path.resolve(__dirname, '..', '..');

/* ------------------------------------------------------------- arguments -- */

const argv = process.argv.slice(2);
function flag(name) { return argv.includes('--' + name); }
function opt(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const HEADED = flag('headed');
const KEEP = flag('keep');           // leave the browser open on failure
const WANTED = opt('browsers', 'chromium,firefox,webkit').split(',')
  .map((s) => s.trim()).filter(Boolean);

// A page that exists in every local build, plus one never visited while online
// so the fallback can be told apart from a cache hit.
const VISITED = '/dev/docs/building-setup-linux.html';
const ALSO_VISITED = '/dev/index.html';
const NEVER_VISITED = '/dev/docs/apmcopter-programming-libraries.html';
const SEARCH_PAGE = '/dev/search.html';

/* ---------------------------------------------------------------- harness -- */

const results = [];
let failures = 0;

/*
 * Where the time goes.
 *
 * This suite drives three real browsers through a full service worker
 * lifecycle, and "it takes a while" is not a useful answer when someone asks
 * why. Every phase is timed and printed, so the cost is attributable rather
 * than mysterious - and so that a change which doubles it is visible.
 */
const timings = [];
async function phase(engine, label, fn) {
  const at = Date.now();
  try {
    return await fn();
  } finally {
    timings.push({ engine, label, ms: Date.now() - at });
  }
}

function check(engine, name, ok, detail) {
  results.push({ engine, name, ok: !!ok, detail: detail || '' });
  if (!ok) { failures++; }
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name +
              (detail ? '   ' + detail : ''));
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * Wait until a service worker is not merely registered but *controlling* this
 * page. The distinction is the whole test: an uncontrolled page goes to the
 * network for its next navigation and shows the browser's own error page,
 * which is exactly the failure this suite exists to catch.
 */
async function waitForControl(page, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) { return { supported: false }; }
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        supported: true,
        controlled: !!navigator.serviceWorker.controller,
        active: !!(reg && reg.active),
        state: reg && reg.active ? reg.active.state : null,
      };
    });
    if (!state.supported) { return state; }
    if (state.controlled) { return state; }
    // The worker claims clients on activate, so control normally arrives
    // without a reload; reload anyway once it is active, for engines that
    // apply claim only to the next navigation.
    if (state.active) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const now = await page.evaluate(
        () => !!navigator.serviceWorker.controller);
      if (now) { return { supported: true, controlled: true, active: true }; }
    }
    await page.waitForTimeout(400);
  }
  return { supported: true, controlled: false, timedOut: true };
}

/**
 * Load every image the page will ever load, then count the ones that decoded.
 *
 * The theme lazy-loads, so a plain count is a count of what happened to be in
 * the viewport: the Creative Commons badge in the footer reports naturalWidth 0
 * online and offline alike, and an offline check that did not scroll would read
 * that as a cache miss. Scrolling to the bottom first makes the online and the
 * offline number comparable, which is the only form of this check that means
 * anything.
 */
async function imageCount(page) {
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => {
      i.loading = 'eager';
    });
  });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const all = Array.from(document.images);
    return {
      total: all.length,
      loaded: all.filter((i) => i.naturalWidth > 0).length,
      missing: all.filter((i) => i.naturalWidth === 0)
        .map((i) => i.currentSrc || i.src),
    };
  });
}

/**
 * Median wall time for a navigation the worker answers, over several goes.
 *
 * The median, not the mean: the first navigation after the worker starts pays
 * for starting it, and one 400 ms outlier in five would drag a mean past a
 * budget that the reader never actually experiences.
 */
async function navigationMs(page, url, runs = 5) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const at = Date.now();
    await page.goto(url, { waitUntil: 'load' });
    times.push(Date.now() - at);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)],
           worst: times[times.length - 1], all: times };
}

/** True when the document looks like a rendered wiki page, not an error. */
async function looksLikeWikiPage(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector('h1');
    return {
      title: document.title,
      h1: h1 ? h1.textContent.trim().slice(0, 80) : null,
      hasNav: !!document.querySelector('.wy-nav-side, nav'),
      styleSheets: document.styleSheets.length,
      // A stylesheet element that failed to load still counts in
      // document.styleSheets, so read a value the theme actually sets.
      themed: getComputedStyle(document.body).fontFamily || '',
      bodyText: (document.body.innerText || '').length,
    };
  });
}


/*
 * A deploy, with a page already open.
 *
 * Shipping a new sw.js is the one routine event that takes control away from
 * every tab already on the site, and control is the whole feature: an
 * uncontrolled page goes to the network for its next navigation, so a reader
 * who goes offline while uncontrolled gets the browser's own error page with a
 * full cache sitting untouched. That state was seen once on the live mirror
 * immediately after a deploy - two navigations with no controller, recovering
 * on its own some time later. The cause was never established. This exists so
 * that if it becomes reproducible it is caught here rather than by a reader.
 *
 * The seeded caches matter. Several things the worker does on activation are
 * skipped entirely when nothing is saved - warmTheme() returns at once with no
 * ardupilot-offline-* cache present - so a fresh profile exercises a shorter
 * path than any real reader with wikis saved. These have the right names, the
 * completion marker the worker checks, and about the entry count of a reader
 * holding the full set.
 *
 * It runs in a context of its own, at the end. Seeding 8,800 entries into the
 * context the other checks use made Firefox flake on timing when three engines
 * ran back to back - a test that perturbs the run it is part of is worse than
 * no test.
 *
 * It passes today, and passed both before and after an attempted fix to the
 * activate handler, which is how that fix was shown to be addressing the wrong
 * thing and was dropped.
 */
async function checkUpdateWindow(name, browser, base) {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  try {
    await page.goto(base + VISITED, { waitUntil: 'load' });
    const control = await waitForControl(page);
    if (!control.controlled) {
      check(name, 'a tab open across a worker update is controlled again',
            false, 'never took control to begin with');
      return;
    }

    const seeded = await page.evaluate(async (wikis) => {
      let total = 0;
      for (const w of wikis) {
        const cache = await caches.open('ardupilot-offline-' + w);
        await cache.put('/__ap_complete__', new Response('1'));
        const puts = [];
        for (let i = 0; i < 800; i++) {
          puts.push(cache.put('/' + w + '/docs/seed-' + i + '.html',
                              new Response('<html><body>seed</body></html>',
                                { headers: { 'Content-Type': 'text/html' } })));
        }
        await Promise.all(puts);
        total += 801;
      }
      return total;
    }, ['copter', 'plane', 'rover', 'sub', 'blimp', 'dev', 'antennatracker',
        'planner', 'planner2', 'ardupilot', 'mavproxy']);

    bumpWorker();
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update();
    });
    const reclaimed = await page.evaluate(async () => {
      const started = Date.now();
      while (Date.now() - started < 10000) {
        if (navigator.serviceWorker.controller) { return Date.now() - started; }
        await new Promise((r) => setTimeout(r, 100));
      }
      return -1;
    });
    check(name, 'a tab open across a worker update is controlled again',
          reclaimed >= 0,
          (reclaimed >= 0 ? reclaimed + ' ms' : 'still none after 10s') +
          ', with ' + seeded + ' entries saved');
  } finally {
    await context.close().catch(() => {});
  }
}

/* ------------------------------------------------------------- one engine -- */

async function runEngine(name, launcher, base) {
  console.log('\n' + name);
  const browser = await phase(name, 'launch browser',
    () => launcher.launch({ headless: !HEADED }));
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();

  /*
   * Only our own errors count.
   *
   * A wiki page embeds YouTube, and Firefox logs a SameSite cookie rejection
   * for every embed; those are the browser reporting on a third party and say
   * nothing about the offline feature. Filtering by the message text would go
   * stale the moment a browser rewords it, so filter by where it came from.
   */
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') { return; }
    const from = (m.location() && m.location().url) || '';
    if (from && !from.startsWith(base)) { return; }
    consoleErrors.push(m.text().slice(0, 300));
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

  let serverHandle = null;
  try {
    /* ---- online: register the worker and read a few pages -------------- */

    const control = await phase(name, 'register + take control', async () => {
      await page.goto(base + VISITED, { waitUntil: 'load' });
      return waitForControl(page);
    });
    check(name, 'service worker takes control',
          control.controlled,
          control.supported === false ? 'no serviceWorker in navigator'
                                      : JSON.stringify(control));
    if (!control.controlled) {
      // Nothing below can mean anything without a controller.
      throw new Error('no controlling service worker');
    }

    const scope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? reg.scope : null;
    });
    check(name, 'worker scope is the whole origin',
          !!scope && new URL(scope).pathname === '/', String(scope));

    // sw.js must not be cacheable, or a broken worker cannot be replaced and
    // the kill switch in frontend/sw-kill.js has no way to reach anyone.
    const swHeaders = await page.evaluate(async () => {
      const r = await fetch('/sw.js', { method: 'HEAD' });
      return { cc: r.headers.get('cache-control'),
               allowed: r.headers.get('service-worker-allowed') };
    });
    check(name, 'sw.js is served no-cache so a bad worker can be replaced',
          /no-cache|no-store|max-age=0/.test(swHeaders.cc || ''),
          'Cache-Control: ' + swHeaders.cc);

    // Read two pages online so they are in the runtime page cache. Reload the
    // first: its initial load happened before the worker controlled anything.
    const onlineImages = await phase(name, 'read pages online', async () => {
      await page.goto(base + VISITED, { waitUntil: 'load' });
      const imgs = await imageCount(page);
      await page.goto(base + ALSO_VISITED, { waitUntil: 'load' });
      return imgs;
    });
    // The search page, so that searchindex.js is fetched at least once. Sphinx
    // loads it from search.html and from nowhere else, so browsing the wiki
    // never brings it into the runtime cache on its own.
    await phase(name, 'load search index', async () => {
      await page.goto(base + SEARCH_PAGE, { waitUntil: 'load' });
      // Give the stale-while-revalidate writes a moment to land.
      await page.waitForTimeout(2500);
    });

    const cached = await page.evaluate(async (p) => {
      const hit = await caches.match(location.origin + p);
      return !!hit;
    }, VISITED);
    check(name, 'visited page is in Cache Storage', cached);

    const quota = await page.evaluate(async () => {
      const out = { estimate: null, persisted: null, canPersist: false };
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        out.estimate = { quota: e.quota, usage: e.usage };
      }
      if (navigator.storage && navigator.storage.persisted) {
        out.persisted = await navigator.storage.persisted();
        out.canPersist = typeof navigator.storage.persist === 'function';
      }
      return out;
    });
    const quotaGB = quota.estimate
      ? (quota.estimate.quota / 1e9).toFixed(1) + ' GB' : 'unreported';
    // The full set of archives is 697 MB, so anything under ~1 GB of quota
    // means the download path cannot complete on this engine.
    check(name, 'storage quota fits the 697 MB archive set',
          !!(quota.estimate && quota.estimate.quota > 750e6),
          'quota ' + quotaGB + ', persist API ' +
          (quota.canPersist ? 'present' : 'MISSING'));

    /*
     * The same page online, with the worker in front of it.
     *
     * stale-while-revalidate answers from storage and refreshes behind, so an
     * online navigation to a page already read should cost about what the
     * offline one costs. If it does not, the worker has started waiting on the
     * network for something it already holds - which is the regression that
     * took one measured page to 1,501 ms with no third-party requests on it.
     */
    const onlineSpeed = await navigationMs(page, base + VISITED);
    check(name, 'an already-read page is not slowed down by being online',
          onlineSpeed.median < 1500,
          'median ' + onlineSpeed.median + ' ms, worst ' + onlineSpeed.worst +
          ' ms of [' + onlineSpeed.all.join(', ') + ']');

    /* ---- go offline for real ------------------------------------------- */

    serverHandle = global.__server;
    await serverHandle.close();
    global.__serverClosed = true;

    /* ---- a page read while online, read again with no server ----------- */

    let navError = null;
    try {
      await page.goto(base + VISITED, { waitUntil: 'load', timeout: 20000 });
    } catch (err) {
      navError = String(err.message).split('\n')[0];
    }
    check(name, 'offline navigation to a visited page does not hit the network',
          !navError, navError || '');

    const shown = await looksLikeWikiPage(page);
    check(name, 'visited page renders its real content offline',
          !!shown.h1 && /build environment/i.test(shown.title || ''),
          'title=' + JSON.stringify((shown.title || '').slice(0, 60)));
    check(name, 'theme CSS is served from cache offline',
          shown.styleSheets > 0 && /roboto|lato|slab|sans/i.test(shown.themed),
          shown.styleSheets + ' stylesheets, font ' +
          JSON.stringify(shown.themed.slice(0, 40)));
    check(name, 'sidebar navigation survives offline', shown.hasNav);

    const offlineImages = await imageCount(page);
    check(name, 'every image that loaded online still loads offline',
          offlineImages.loaded >= onlineImages.loaded,
          offlineImages.loaded + '/' + offlineImages.total + ' offline vs ' +
          onlineImages.loaded + '/' + onlineImages.total + ' online' +
          (offlineImages.missing.length
            ? '; missing ' + offlineImages.missing.slice(0, 2).join(', ') : ''));

    /*
     * How fast, not just whether.
     *
     * The whole argument for a service worker here is that a stored page is
     * quicker than a fetched one, and every strategy in sw.js was chosen on a
     * measurement: cache-first for _static because revalidating cost twenty
     * background requests a navigation, an exact cache.match because ignoring
     * the query string measured 63-79 ms against 0.1-0.3 ms. None of that was
     * ever guarded, so the next change that quietly reintroduces a per-asset
     * round trip would show up as "still passes, feels slower".
     *
     * Offline there is no network to blame, so the number is the worker plus
     * the render, and a budget can be honest. 1200 ms is deliberately loose -
     * it is the wall time of a full navigation including layout in a headless
     * browser on a busy machine, not a microbenchmark, and it is set to catch a
     * strategy regression rather than to police tens of milliseconds.
     */
    const offlineSpeed = await navigationMs(page, base + VISITED);
    check(name, 'a stored page is served offline well inside the budget',
          offlineSpeed.median < 1200,
          'median ' + offlineSpeed.median + ' ms, worst ' + offlineSpeed.worst +
          ' ms of [' + offlineSpeed.all.join(', ') + ']');

    /*
     * Offline search.
     *
     * searchindex.js sits at a wiki's root, so it matches none of the worker's
     * page, image or _static routes; it was served from storage by nothing at
     * all and offline search failed silently while the file sat in the archive.
     *
     * The search page was opened online above, which is the only thing that
     * fetches this file. Fetching it again with no network is the check: if it
     * resolves with a body, offline search has what it needs.
     */
    const searchIndex = await page.evaluate(async () => {
      try {
        const r = await fetch('/dev/searchindex.js');
        const t = await r.text();
        return { ok: r.ok, bytes: t.length };
      } catch (err) {
        return { ok: false, error: String(err.message) };
      }
    });
    check(name, 'the search index is reachable offline',
          searchIndex.ok && searchIndex.bytes > 1000,
          searchIndex.error || (searchIndex.bytes + ' bytes'));

    /* ---- a page never visited: the fallback, not a browser error ------- */

    let fallbackError = null;
    try {
      await page.goto(base + NEVER_VISITED,
                      { waitUntil: 'load', timeout: 20000 });
    } catch (err) {
      fallbackError = String(err.message).split('\n')[0];
    }
    check(name, 'offline navigation to an unsaved page is answered by the worker',
          !fallbackError, fallbackError || '');

    if (!fallbackError) {
      const fb = await page.evaluate(() => ({
        text: (document.body.innerText || '').slice(0, 200),
        title: document.title,
      }));
      check(name, 'unsaved page shows the offline fallback, not a dead end',
            /offline/i.test(fb.text) || /offline/i.test(fb.title),
            JSON.stringify(fb.title));
    }

    /* ---- the offline panel itself -------------------------------------- */

    let panelError = null;
    try {
      await page.goto(base + '/ardupilot/docs/common-offline.html',
                      { waitUntil: 'load', timeout: 20000 });
    } catch (err) {
      panelError = String(err.message).split('\n')[0];
    }
    // The panel is network-only by design (markup and script are one unit), so
    // offline it is expected to fall back rather than render. Only assert that
    // it does not leave the reader on a browser error page.
    check(name, 'offline panel degrades to the fallback rather than an error',
          !panelError, panelError || '');

    /* ---- back online ---------------------------------------------------- */

    const restarted = await start(serverHandle.port);
    global.__server = restarted;
    global.__serverClosed = false;
    serverHandle = null;

    await page.goto(base + NEVER_VISITED, { waitUntil: 'load', timeout: 20000 });
    const back = await looksLikeWikiPage(page);
    check(name, 'the same page loads normally once the network returns',
          !!back.h1, 'h1=' + JSON.stringify(back.h1));

    /*
     * WebKit logs the browser's own service worker update check when it fails.
     *
     * Every engine re-fetches sw.js on navigation, and with the origin down
     * that fetch cannot succeed. pwa.js catches the rejection from its explicit
     * registration.update(), but the failed request is still logged by the
     * browser itself - WebKit as "...sw.js due to access control checks" - and
     * no page code can suppress a resource load the browser reports. It is a
     * report about the network, not about this feature, and every offline check
     * above passes with it in the log.
     *
     * Matched on the subject rather than the wording: the wording is the part
     * that differs between engines and changes between releases.
     */
    const fatal = consoleErrors
      .concat(pageErrors)
      .filter((t) => !/favicon|Failed to load resource/i.test(t))
      .filter((t) => !/\/sw\.js/.test(t));
    check(name, 'no unexplained console errors', fatal.length === 0,
          fatal.slice(0, 3).join(' | '));

    // Last, and in a context of its own: see checkUpdateWindow.
    await phase(name, 'deploy check (seeds 8,811 entries)',
                () => checkUpdateWindow(name, browser, base));
  } catch (err) {
    check(name, 'engine run completed', false, String(err.message));
  } finally {
    if (!(KEEP && failures)) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------- main -- */

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (err) {
    console.error('playwright is not installed.\n\n' +
                  '  npm install --save-dev playwright\n' +
                  '  npx playwright install chromium firefox webkit\n');
    process.exit(2);
  }

  const engines = { chromium: playwright.chromium, firefox: playwright.firefox,
                    webkit: playwright.webkit };

  const handle = await start(0);
  global.__server = handle;
  const base = 'http://localhost:' + handle.port;
  console.log('serving the built tree on ' + base +
              ' (from ' + REPO + ')\n');

  for (const name of WANTED) {
    if (!engines[name]) {
      console.log('\n' + name + '\n  SKIP  unknown engine');
      continue;
    }
    // Each engine gets a live server; runEngine stops and restarts it.
    if (global.__serverClosed) {
      global.__server = await start(handle.port);
      global.__serverClosed = false;
    }
    try {
      await runEngine(name, engines[name], base);
    } catch (err) {
      check(name, 'engine launched', false, String(err.message));
      if (global.__serverClosed) {
        global.__server = await start(handle.port);
        global.__serverClosed = false;
      }
    }
  }

  if (global.__server && !global.__serverClosed) {
    await global.__server.close();
  }

  /* A matrix, because the point of this suite is comparing engines. */
  const names = [];
  results.forEach((r) => {
    if (!names.includes(r.name)) { names.push(r.name); }
  });
  const engineList = WANTED.filter((e) => results.some((r) => r.engine === e));
  const width = Math.max.apply(null, names.map((n) => n.length).concat([20]));

  console.log('\n' + ' '.repeat(width) + '  ' +
              engineList.map((e) => e.padEnd(9)).join(''));
  names.forEach((n) => {
    const cells = engineList.map((e) => {
      const r = results.find((x) => x.engine === e && x.name === n);
      return (r ? (r.ok ? 'pass' : 'FAIL') : '-').padEnd(9);
    });
    console.log(n.padEnd(width) + '  ' + cells.join(''));
  });

  /*
   * And where the time went. Three browsers, each taken through a full worker
   * lifecycle, is not fast and should not pretend to be; what matters is that
   * the cost is attributable.
   */
  const labels = [];
  timings.forEach((t) => {
    if (!labels.includes(t.label)) { labels.push(t.label); }
  });
  if (labels.length) {
    const lw = Math.max.apply(null, labels.map((l) => l.length).concat([20]));
    console.log('\ntime spent, seconds\n');
    console.log(' '.repeat(lw) + '  ' +
                engineList.map((e) => e.padEnd(9)).join('') + 'total');
    labels.forEach((l) => {
      let row = 0;
      const cells = engineList.map((e) => {
        const t = timings.find((x) => x.engine === e && x.label === l);
        if (!t) { return '-'.padEnd(9); }
        row += t.ms;
        return (t.ms / 1000).toFixed(1).padEnd(9);
      });
      console.log(l.padEnd(lw) + '  ' + cells.join('') + (row / 1000).toFixed(1));
    });
    const grand = timings.reduce((a, t) => a + t.ms, 0);
    console.log('\n' + 'measured total'.padEnd(lw) + '  ' +
                ' '.repeat(9 * engineList.length) + (grand / 1000).toFixed(1) +
                '  (the rest is per-check evaluation)');
  }

  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED\n'
                       : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
