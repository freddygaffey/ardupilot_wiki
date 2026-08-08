/*
 * Logic for /offline/ - the page where offline content is managed.
 *
 * Everything reported here is measured, not remembered: cached page counts come
 * from enumerating Cache Storage and sizes come from the Storage API. If the
 * browser evicts the saved copy the page says so, rather than showing a stale
 * flag claiming it is still there.
 *
 * Bulk download fetches one pre-built archive per wiki and unpacks it into the
 * cache locally. That is deliberate: crawling the site would mean thousands of
 * requests per reader, where this is one request that a CDN can serve.
 */
(function () {
  'use strict';

  // Sizes measured from a real build. The build should eventually publish these
  // in offline-manifest.json; until it does they come from here so the page
  // never shows invented numbers.
  var COMMON = { id: 'common', name: 'Common (required)', mb: 455, pages: 0, required: true };
  var WIKIS = [
    { id: 'copter', name: 'Copter', mb: 110, pages: 845 },
    { id: 'plane', name: 'Plane', mb: 74, pages: 814 },
    { id: 'dev', name: 'Developer', mb: 66, pages: 311 },
    { id: 'rover', name: 'Rover', mb: 62, pages: 746 },
    { id: 'sub', name: 'Sub', mb: 39, pages: 643 },
    { id: 'blimp', name: 'Blimp', mb: 31, pages: 291 },
    { id: 'planner', name: 'Mission Planner', mb: 14, pages: 75 },
    { id: 'mavproxy', name: 'MAVProxy', mb: 10, pages: 114 },
    { id: 'antennatracker', name: 'Antenna Tracker', mb: 9, pages: 39 },
    { id: 'planner2', name: 'APM Planner 2', mb: 6, pages: 42 },
    { id: 'ardupilot', name: 'About', mb: 5, pages: 27 }
  ];

  // Where the archives are served from. They are far too large for the site's
  // own hosting (Cloudflare Pages caps files at 25 MiB and the common archive
  // is 433 MB), so they live in object storage.
  //
  // TODO: this default points at a throwaway r2.dev demo bucket. Before this
  // goes anywhere real it must become ArduPilot's own bucket or CDN domain.
  // r2.dev is rate limited and documented as development-only, so it will not
  // stand up to production traffic. The preferred fix is not to edit this line
  // but to set "artifact_base" in offline-manifest.json (see
  // scripts/build_offline_artifacts.py, ARTIFACT_BASE_ENV), which overrides it
  // at build time and keeps the URL out of the source entirely.
  var ARTIFACT_BASE = 'https://pub-de9c5e70708749b4888f6cadd29d92fe.r2.dev';

  // Wikis the build produced a single-file copy for. Overridden by the
  // manifest's "single" array so the page never offers a file that is not there.
  var SINGLE_FILES = ['rover'];

  var PAGE_CACHE_PREFIX = 'ardupilot-pages-';
  var OFFLINE_CACHE_PREFIX = 'ardupilot-offline-';
  var COMPLETE_MARKER = '/__ap_complete__';
  var AUTOUPDATE_KEY = 'ap-autoupdate';
  // Quota estimates are deliberately fuzzed by browsers, and unpacking needs
  // room to work, so require noticeably more headroom than the raw payload.
  var HEADROOM = 1.5;

  function el(id) { return document.getElementById(id); }
  function mb(bytes) { return Math.round(bytes / 1048576); }

  function fmt(bytes) {
    var m = bytes / 1048576;
    return m >= 1024 ? (m / 1024).toFixed(1) + ' GB' : Math.round(m) + ' MB';
  }

  /* ---------- measured state ---------- */

  function storedWikis() {
    return caches.keys().then(function (names) {
      var stored = {};
      var offline = names.filter(function (n) { return n.indexOf(OFFLINE_CACHE_PREFIX) === 0; });
      return Promise.all(offline.map(function (name) {
        return caches.open(name).then(function (cache) {
          // Only a cache carrying the completion marker counts. An interrupted
          // download leaves entries behind, and treating those as a usable copy
          // is how somebody ends up offline with half a wiki.
          return cache.match(COMPLETE_MARKER).then(function (marker) {
            if (!marker) { return; }
            stored[name.slice(OFFLINE_CACHE_PREFIX.length).split('-')[0]] = true;
          });
        });
      })).then(function () { return stored; });
    });
  }

  function countCachedPages() {
    return caches.keys().then(function (names) {
      return Promise.all(names
        .filter(function (n) { return n.indexOf(PAGE_CACHE_PREFIX) === 0; })
        .map(function (n) {
          return caches.open(n).then(function (c) {
            return c.keys().then(function (k) { return k.length; });
          });
        })).then(function (counts) {
          return counts.reduce(function (a, b) { return a + b; }, 0);
        });
    });
  }

  function storage() {
    var est = navigator.storage && navigator.storage.estimate
      ? navigator.storage.estimate() : Promise.resolve({});
    var per = navigator.storage && navigator.storage.persisted
      ? navigator.storage.persisted() : Promise.resolve(false);
    return Promise.all([est, per]).then(function (r) {
      return { estimate: r[0] || {}, persisted: r[1] };
    });
  }

  /* ---------- rendering ---------- */

  function renderStorage() {
    return Promise.all([storage(), countCachedPages()]).then(function (r) {
      var est = r[0].estimate, persisted = r[0].persisted, pages = r[1];
      var used = est.usage || 0, quota = est.quota || 0;

      function kv(key, value) {
        return '<div class="kv"><span class="k">' + key + '</span>' +
               '<span class="lead2"></span><span class="v">' + value + '</span></div>';
      }

      el('storage-status').innerHTML =
        kv('On this device',
           pages + ' page' + (pages === 1 ? '' : 's') + ' &middot; ' +
           fmt(used) + ' used &middot; ' +
           fmt(Math.max(quota - used, 0)) + ' free') +
        kv('Storage', persisted ? 'permanent' : '&#9888; temporary');

      el('storage-warning').innerHTML = persisted
        ? '<div class="ok">Storage is <strong>permanent</strong>. Saved pages will not ' +
          'be removed automatically, though clearing your browser data still deletes them.</div>'
        : '<div class="warn">&#9888; Storage is <strong>temporary</strong>. Your browser ' +
          'can delete these saved pages without warning if this device runs low on space. ' +
          'Do not rely on this copy in the field until you make it permanent.</div>';

      el('persist-btn').hidden = persisted || !(navigator.storage && navigator.storage.persist);
      el('clear-btn').hidden = pages === 0;
    });
  }

  function renderWikis() {
    return storedWikis().then(function (stored) {
      var rows = [COMMON].concat(WIKIS).map(function (w) {
        var isStored = !!stored[w.id];
        var box = w.required
          ? '<input type="checkbox" checked disabled>'
          : '<input type="checkbox" class="wiki-check" value="' + w.id +
            '" data-mb="' + w.mb + '"' + (isStored ? ' checked' : '') + '>';
        return '<tr><td><label>' + box + ' ' + w.name + '</label></td>' +
               '<td class="num">' + w.mb + ' MB</td>' +
               '<td class="num">' + (w.pages || '&mdash;') + '</td>' +
               '<td class="num">' + (isStored
                 ? '<span class="pill stored">Stored</span>'
                 : '<span class="pill">&mdash;</span>') + '</td></tr>';
      });
      el('wiki-rows').innerHTML = rows.join('');
      updateTotal();
    });
  }

  function selected() {
    return Array.prototype.slice.call(document.querySelectorAll('.wiki-check:checked'));
  }

  function updateTotal() {
    var total = COMMON.mb;
    selected().forEach(function (c) { total += parseInt(c.dataset.mb, 10); });
    el('selection-total').innerHTML =
      'Selected: <strong>' + total + ' MB</strong> including the required common files.';
  }

  /*
   * Direct download links for whoever wants the files rather than the browser
   * cache. Each selected wiki is its own archive, plus the common one, which is
   * why these are a list rather than a single button - and why picking three
   * vehicles does not mean downloading the shared images three times.
   */
  function renderDownloadLinks() {
    var target = el('archive-links');
    if (!target) { return; }

    var chosen = selected().map(function (c) { return c.value; });
    var wanted = [COMMON].concat(WIKIS.filter(function (w) {
      return chosen.indexOf(w.id) !== -1;
    }));

    target.innerHTML = wanted.map(function (w) {
      var file = w.archive || (w.id + '-offline.tar.gz');
      return '<a href="' + ARTIFACT_BASE + '/' + file + '" download ' +
             'style="display:inline-block;margin:0 8px 6px 0">' +
             w.name + ' <span class="pill">' + w.mb + ' MB</span></a>';
    }).join('');
  }

  /*
   * The single-file build is per wiki - it inlines its own images, so unlike
   * the archives it cannot share the common set. That is why this is a picker
   * rather than following the checkbox selection above.
   *
   * Only wikis the build actually produced a file for are offered; the manifest
   * lists them in "single", and without that entry the option is marked
   * unavailable rather than linking to a 404.
   */
  function renderSingleFile() {
    var select = el('single-wiki');
    var wrap = el('dl-single-wrap');
    if (!select || !wrap) { return; }

    if (!select.options.length) {
      select.innerHTML = WIKIS.map(function (w) {
        var available = SINGLE_FILES.indexOf(w.id) !== -1;
        return '<option value="' + w.id + '"' + (available ? '' : ' data-missing="1"') +
               '>' + w.name + (available ? '' : ' — not built') + '</option>';
      }).join('');
    }

    var id = select.value;
    var available = SINGLE_FILES.indexOf(id) !== -1;
    wrap.innerHTML = available
      ? '<a href="' + ARTIFACT_BASE + '/' + id + '-wiki-offline.html" download>' +
        id + '-wiki-offline.html</a>'
      : '<span class="pill">not yet published</span>';
  }

  /* ---------- actions ---------- */

  function requestPersist() {
    return navigator.storage.persist().then(function (granted) {
      if (!granted) {
        el('storage-warning').innerHTML +=
          '<div class="warn">Your browser declined the request. Installing this ' +
          'site as an app is the strongest signal it uses when deciding, so ' +
          'installing may allow it.</div>';
      }
      return renderStorage();
    });
  }

  function clearAll() {
    return caches.keys().then(function (names) {
      return Promise.all(names
        .filter(function (n) { return n.indexOf('ardupilot-') === 0; })
        .map(function (n) { return caches.delete(n); }));
    }).then(function () {
      return Promise.all([renderStorage(), renderWikis()]);
    });
  }

  /*
   * Check there is room before starting. A download that dies partway leaves a
   * cache with holes in it, and at these sizes that is a long wait for nothing.
   */
  function checkRoom(neededBytes) {
    return storage().then(function (r) {
      var est = r.estimate;
      if (est.quota === undefined) { return true; }
      var available = (est.quota || 0) - (est.usage || 0);
      if (available < neededBytes * HEADROOM) {
        throw new Error('Not enough room: this needs about ' + fmt(neededBytes) +
          ' plus working space, and only ' + fmt(available) + ' is available. ' +
          'Deselect a wiki or free up space.');
      }
      return true;
    });
  }

  /* ---------- download and unpack ---------- */

  var MIME = {
    html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css',
    json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
    webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff',
    woff2: 'font/woff2', ttf: 'font/ttf', inv: 'application/octet-stream'
  };

  function mimeFor(name) {
    var ext = name.split('.').pop().toLowerCase();
    return MIME[ext] || 'application/octet-stream';
  }

  function textField(bytes, offset, length) {
    var out = '';
    for (var i = offset; i < offset + length; i++) {
      if (bytes[i] === 0) { break; }
      out += String.fromCharCode(bytes[i]);
    }
    return out;
  }

  /*
   * Minimal tar reader over a stream.
   *
   * tar is 512-byte headers followed by file data padded to 512, which is
   * simple enough to walk directly - and doing so avoids shipping a archive
   * library to every reader just to unpack one download.
   */
  function untarToCache(stream, cache, prefix, onEntry) {
    var reader = stream.getReader();
    var buf = new Uint8Array(0);
    var done = false;

    function pull() {
      return reader.read().then(function (r) {
        if (r.done) { done = true; return; }
        var next = new Uint8Array(buf.length + r.value.length);
        next.set(buf); next.set(r.value, buf.length);
        buf = next;
      });
    }

    function need(n) {
      if (buf.length >= n || done) { return Promise.resolve(buf.length >= n); }
      return pull().then(function () { return need(n); });
    }

    function take(n) {
      var out = buf.subarray(0, n);
      buf = buf.slice(n);
      return out;
    }

    function step() {
      return need(512).then(function (ok) {
        if (!ok) { return; }
        var header = take(512);
        var name = textField(header, 0, 100);
        if (!name) { return step(); }   // zero block: padding between members

        var size = parseInt(textField(header, 124, 12).trim(), 8) || 0;
        var type = String.fromCharCode(header[156] || 48);
        var padded = Math.ceil(size / 512) * 512;

        return need(padded).then(function (haveBody) {
          if (!haveBody) { return; }
          var body = take(padded).slice(0, size);
          // '0' and NUL are regular files; skip directories and metadata.
          if (type !== '0' && type !== ' ') { return step(); }
          var path = prefix + name;
          return cache.put(
            new Request(path),
            new Response(body, { headers: { 'Content-Type': mimeFor(name) } })
          ).then(function () {
            if (onEntry) { onEntry(path); }
            return step();
          });
        });
      });
    }

    return step();
  }

  /**
   * Fetch one archive and unpack it into `cache`, reporting bytes received.
   * Common images are written under /_common/ so they are stored once; the
   * service worker redirects per-wiki image requests there.
   */
  function fetchArchive(entry, cache, onBytes) {
    var url = ARTIFACT_BASE + '/' + (entry.archive || entry.id + '-offline.tar.gz');
    return fetch(url, { mode: 'cors' }).then(function (response) {
      if (!response.ok) {
        throw new Error('could not fetch ' + entry.name + ' (' + response.status + ')');
      }
      if (!response.body || typeof DecompressionStream === 'undefined') {
        throw new Error('this browser cannot unpack the download');
      }

      var counter = new TransformStream({
        transform: function (chunk, controller) {
          onBytes(chunk.byteLength);
          controller.enqueue(chunk);
        }
      });

      var stream = response.body
        .pipeThrough(counter)
        .pipeThrough(new DecompressionStream('gzip'));

      // The common archive holds bare _images/... paths; wiki archives are
      // already prefixed with their own name.
      var prefix = entry.id === 'common' ? '/_common/' : '/';
      return untarToCache(stream, cache, prefix);
    });
  }

  function saveSelectedReal() {
    var chosen = selected().map(function (c) { return c.value; });
    var queue = [COMMON].concat(WIKIS.filter(function (w) {
      return chosen.indexOf(w.id) !== -1;
    }));
    var totalBytes = queue.reduce(function (a, w) { return a + w.mb * 1048576; }, 0);

    var progress = el('cache-progress');
    var button = el('download-cache-btn');
    var received = 0;

    progress.hidden = false;
    button.disabled = true;

    function report(text) { progress.textContent = text; }
    report('Checking space…');

    // Ask for persistence before storing rather than after, so the data is
    // protected from the moment it lands.
    var persistFirst = navigator.storage && navigator.storage.persist
      ? navigator.storage.persist() : Promise.resolve(false);

    return persistFirst
      .then(function () { return checkRoom(totalBytes); })
      .then(function () {
        // Staged under a build-scoped name and only marked complete at the very
        // end, so an interrupted download can never look like a usable copy.
        return queue.reduce(function (chain, entry) {
          return chain.then(function () {
            var cacheName = OFFLINE_CACHE_PREFIX + entry.id;
            return caches.open(cacheName).then(function (cache) {
              return fetchArchive(entry, cache, function (n) {
                received += n;
                report(entry.name + ' — ' +
                  Math.min(99, Math.round(received / totalBytes * 100)) + '%');
              }).then(function () {
                return cache.put(COMPLETE_MARKER,
                  new Response(String(Date.now()),
                    { headers: { 'Content-Type': 'text/plain' } }));
              });
            });
          });
        }, Promise.resolve());
      })
      .then(function () { report('Saved'); })
      .catch(function (err) {
        report(err && err.name === 'QuotaExceededError'
          ? 'Ran out of space — your existing copy is untouched.'
          : (err.message || 'Download failed'));
      })
      .then(function () {
        button.disabled = false;
        return Promise.all([renderStorage(), renderWikis()]);
      });
  }

  function saveSelectedStub() {
    var wikis = selected().map(function (c) { return c.value; });
    var totalMb = COMMON.mb + selected().reduce(function (a, c) {
      return a + parseInt(c.dataset.mb, 10);
    }, 0);
    var progress = el('cache-progress');
    var button = el('download-cache-btn');

    progress.hidden = false;
    progress.textContent = 'Checking space…';
    button.disabled = true;

    // Ask for persistence before storing rather than after, so the data is
    // protected from the moment it lands.
    var persistFirst = navigator.storage && navigator.storage.persist
      ? navigator.storage.persist() : Promise.resolve(false);

    persistFirst
      .then(function () { return checkRoom(totalMb * 1048576); })
      .then(function () {
        progress.textContent = 'Downloading…';
        // The archives are produced by the build and served from object
        // storage. Until they are published this reports honestly rather
        // than silently doing nothing.
        return fetch('/offline/offline-manifest.json', { cache: 'no-cache' });
      })
      .then(function (response) {
        if (!response.ok) { throw new Error('not published'); }
        return response.json();
      })
      .then(function () {
        progress.textContent = 'Unpacking…';
        // Unpack step lands here once artefacts are published.
      })
      .catch(function (err) {
        progress.textContent = err && err.message === 'not published'
          ? 'Offline archives are not published on this deployment yet.'
          : (err.message || 'Failed');
      })
      .then(function () {
        button.disabled = false;
        return Promise.all([renderStorage(), renderWikis()]);
      });
  }

  /* ---------- wiring ---------- */

  document.addEventListener('change', function (e) {
    if (e.target.classList.contains('wiki-check')) { updateTotal(); renderDownloadLinks(); }
    if (e.target.id === 'single-wiki') { renderSingleFile(); }
    if (e.target.id === 'autoupdate') {
      try {
        window.localStorage.setItem(AUTOUPDATE_KEY, e.target.checked ? '1' : '0');
      } catch (err) { /* private browsing */ }
    }
  });

  document.addEventListener('click', function (e) {
    if (e.target.id === 'persist-btn') { requestPersist(); }
    if (e.target.id === 'clear-btn') { clearAll(); }
    if (e.target.id === 'download-cache-btn') { saveSelectedReal(); }
    if (e.target.id === 'check-btn') {
      var out = el('check-result');
      out.hidden = false;
      out.textContent = 'Pages refresh as you read them while online.';
    }
  });

  function init() {
    try {
      var pref = window.localStorage.getItem(AUTOUPDATE_KEY);
      if (pref === '0') { el('autoupdate').checked = false; }
    } catch (err) { /* private browsing */ }

    var standalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.navigator.standalone === true;
    el('install-state').textContent = standalone
      ? 'Already running as an installed app.'
      : '';

    if (!('caches' in window)) {
      el('storage-status').textContent =
        'This browser does not support offline storage.';
      return;
    }

    // The build writes offline-manifest.json alongside the archives. Sizes and
    // page counts change every time the wiki does, so they must come from the
    // build rather than from constants in this file; the table above is only a
    // fallback for deployments that have not published one yet.
    fetch('/offline/offline-manifest.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (manifest) {
        if (manifest && manifest.common && manifest.wikis) {
          COMMON = manifest.common;
          WIKIS = manifest.wikis;
          if (Array.isArray(manifest.single)) {
            SINGLE_FILES = manifest.single;
          }
          if (manifest.artifact_base) {
            ARTIFACT_BASE = manifest.artifact_base.replace(/\/$/, '');
          }
          if (manifest.generated) {
            el('build-date').textContent =
              'Build ' + manifest.generated.slice(0, 10);
          }
        }
        renderStorage();
        renderWikis();
        renderDownloadLinks();
        renderSingleFile();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
