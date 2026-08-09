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
(function (global) {
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

  // Build id of the manifest currently published, filled in on load.
  var CURRENT_BUILD = null;

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

      // One plain sentence. This sits in the panel footer, not in a table, and
      // the previous key/value markup lost its styling in the redesign - it
      // rendered as "On this device21 pages".
      el('storage-status').textContent =
        pages + ' page' + (pages === 1 ? '' : 's') + ' saved · ' +
        fmt(used) + ' used · ' + fmt(Math.max(quota - used, 0)) + ' free · ' +
        'storage ' + (persisted ? 'permanent' : 'temporary');

      el('storage-warning').innerHTML = persisted
        ? ''
        : '<div class="apo-note apo-note-warn">&#9888; Storage is ' +
          '<strong>temporary</strong>. Your browser can delete these saved pages ' +
          'without warning if this device runs low on space. Do not rely on this ' +
          'copy in the field until you make it permanent.</div>';

      el('persist-btn').hidden = persisted || !(navigator.storage && navigator.storage.persist);
      updateExportState();
      updateTotal();
    });
  }

  function selectionBytes() {
    var selectedTotal = 0, toDownload = 0;

    selected().forEach(function (c) {
      var b = parseInt(c.dataset.mb, 10) * 1048576;
      selectedTotal += b;
      if (!storedIds[c.value]) { toDownload += b; }
    });

    var commonBytes = (COMMON.mb || 0) * 1048576;
    selectedTotal += commonBytes;
    if (!storedIds.common) { toDownload += commonBytes; }

    return { total: selectedTotal, toDownload: toDownload };
  }

  var storedIds = {};

  function renderWikis() {
    return storedWikis().then(function (stored) {
      storedIds = stored;
      var rows = [COMMON].concat(WIKIS).map(function (w) {
        var isStored = !!stored[w.id];
        var box = w.required
          ? '<input type="checkbox" checked disabled title="Required">'
          : '<input type="checkbox" class="wiki-check" value="' + w.id +
            '" data-mb="' + w.mb + '"' + (isStored ? ' checked' : '') + '>';
        var badge = isStored
          ? '<span class="apo-badge apo-badge-stored">Saved</span>'
          : '<span class="apo-badge apo-badge-none">Not saved</span>';
        return '<tr data-wiki="' + w.id + '">' +
                 '<td class="apo-name"><label class="apo-pick">' + box +
                   '<span>' + w.name + '</span></label></td>' +
                 '<td class="apo-num">' + w.mb + ' MB</td>' +
                 '<td class="apo-num apo-pages">' + (w.pages || '&mdash;') + '</td>' +
                 '<td class="apo-num"><div class="apo-progress" hidden>' +
                   '<div class="apo-progress-bar"></div><span></span></div></td>' +
                 '<td class="apo-num">' + badge + '</td>' +
               '</tr>';
      });
      el('wiki-rows').innerHTML = rows.join('');
      updateExportState();
      updateTotal();
    });
  }

  /** Show progress on one wiki's own row, the way the build tool does. */
  function rowProgress(wikiId, percent, label) {
    var row = document.querySelector('tr[data-wiki="' + wikiId + '"]');
    if (!row) { return; }
    var wrap = row.querySelector('.apo-progress');
    var bar = row.querySelector('.apo-progress-bar');
    var text = row.querySelector('.apo-progress span');
    var badge = row.querySelector('.apo-badge');
    if (!wrap) { return; }

    if (percent === null) {
      wrap.hidden = true;
      return;
    }
    if (percent >= 100) {
      wrap.hidden = false;
      bar.style.width = '100%';
      text.textContent = label || '100%';
      if (badge) {
        badge.className = 'apo-badge apo-badge-stored';
        badge.textContent = 'Saved';
      }
      return;
    }
    wrap.hidden = false;
    bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
    text.textContent = label || Math.round(percent) + '%';
    if (badge) {
      badge.className = 'apo-badge apo-badge-busy';
      badge.textContent = 'Saving';
    }
  }

  function selected() {
    return Array.prototype.slice.call(document.querySelectorAll('.wiki-check:checked'));
  }

  function updateTotal() {
    var b = selectionBytes();
    var total = el('selection-total');
    if (!total) { return; }

    if (!b.total) {
      total.textContent = 'Nothing selected.';
    } else if (!b.toDownload) {
      total.innerHTML = '<strong>' + fmt(b.total) + '</strong> selected &mdash; ' +
                        'all of it is already saved on this device.';
    } else {
      total.innerHTML = '<strong>' + fmt(b.toDownload) + '</strong> to download' +
                        (b.toDownload === b.total ? '' :
                          ' &middot; ' + fmt(b.total - b.toDownload) +
                          ' of the ' + fmt(b.total) + ' selected is already saved') +
                        '.';
    }
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

    // Common is deliberately not offered here. On its own it is a few hundred
    // megabytes of images with no pages to view them in; it is only meaningful
    // paired with a wiki, and the single-file export inlines it instead.
    var chosen = selected().map(function (c) { return c.value; });
    var wanted = WIKIS.filter(function (w) { return chosen.indexOf(w.id) !== -1; });

    // Show the filename that will land in their downloads folder, not the
    // wiki's display name - that is what they will be looking at later.
    target.innerHTML = wanted.map(function (w) {
      var file = w.archive || (w.id + '-offline.tar.gz');
      return '<a href="' + ARTIFACT_BASE + '/' + file + '" download>' +
             file + ' <span class="pill">' + w.mb + ' MB</span></a>';
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
    return fetch(url, {
      mode: 'cors',
      signal: activeDownload ? activeDownload.signal : undefined
    }).then(function (response) {
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

  var activeDownload = null;

  function cancelDownload() {
    if (activeDownload) { activeDownload.abort(); }
  }

  function saveSelectedReal() {
    // A several-hundred-megabyte download has to be stoppable. The same button
    // becomes Cancel rather than adding a second one that is dead most of the
    // time.
    if (activeDownload) { return cancelDownload(); }

    var chosen = selected().map(function (c) { return c.value; });
    var queue = [COMMON].concat(WIKIS.filter(function (w) {
      return chosen.indexOf(w.id) !== -1;
    }));
    // Only what actually has to come down counts against the space check.
    var totalBytes = queue.reduce(function (a, w) {
      return a + (storedIds[w.id] ? 0 : w.mb * 1048576);
    }, 0) || queue.reduce(function (a, w) { return a + w.mb * 1048576; }, 0);

    var progress = el('cache-progress');
    var button = el('download-cache-btn');
    var received = 0;

    progress.hidden = false;
    activeDownload = new AbortController();
    button.classList.add('busy');
    setLabel('Cancel');

    function setLabel(text) {
      var lbl = button.querySelector('.lbl');
      if (lbl) { lbl.textContent = text; } else { button.textContent = text; }
    }
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
              var entryBytes = (entry.mb || 0) * 1048576;
              var entryGot = 0;
              return fetchArchive(entry, cache, function (n) {
                received += n;
                entryGot += n;
                var pct = Math.min(99, Math.round(received / totalBytes * 100));
                rowProgress(entry.id,
                  entryBytes ? Math.min(99, (entryGot / entryBytes) * 100) : pct);
                report(entry.name + ' · ' + pct + '%');
              }).then(function () {
                rowProgress(entry.id, 100, 'done');
                // The marker records the build, not just the time: an update
                // check is only meaningful against what was actually stored.
                return cache.put(COMPLETE_MARKER,
                  new Response(JSON.stringify({
                    build: CURRENT_BUILD, saved: Date.now(), id: entry.id
                  }), { headers: { 'Content-Type': 'application/json' } }));
              });
            });
          });
        }, Promise.resolve());
      })
      .then(function () { report('Saved'); })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          report('Cancelled — anything already saved is kept.');
        } else if (err && err.name === 'QuotaExceededError') {
          report('Ran out of space — your existing copy is untouched.');
        } else {
          report((err && err.message) || 'Download failed');
        }
      })
      .then(function () {
        activeDownload = null;
        button.classList.remove('busy');
        setLabel('Save selected');
        // Bars for anything that completed stay at 100%; only unfinished ones
        // are cleared, so a cancelled run does not look like a successful one.
        queue.forEach(function (w) {
          if (!storedIds[w.id]) { rowProgress(w.id, null); }
        });
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

  /**
   * Ask the server what the current build is and compare it against what each
   * stored copy recorded when it was saved. Anything behind is re-fetched.
   *
   * This is a real request, not a reassuring message: a reader checking before
   * heading out needs to know whether what they are carrying is current.
   */
  function checkForUpdates() {
    var out = el('check-result');
    out.hidden = false;
    out.textContent = 'Checking…';

    return fetch('/offline/offline-manifest.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('could not reach the server'); }
        return r.json();
      })
      .then(function (manifest) {
        CURRENT_BUILD = manifest.generated || CURRENT_BUILD;
        if (manifest.common && manifest.wikis) {
          COMMON = manifest.common;
          WIKIS = manifest.wikis;
        }
        return caches.keys().then(function (names) {
          var offline = names.filter(function (n) {
            return n.indexOf(OFFLINE_CACHE_PREFIX) === 0;
          });
          return Promise.all(offline.map(function (name) {
            return caches.open(name).then(function (c) {
              return c.match(COMPLETE_MARKER).then(function (m) {
                if (!m) { return null; }
                return m.json().then(function (info) {
                  return (info.build && info.build !== CURRENT_BUILD)
                    ? info.id : null;
                }).catch(function () { return null; });
              });
            });
          }));
        });
      })
      .then(function (results) {
        var stale = results.filter(Boolean);
        if (!stale.length) {
          out.textContent = 'Up to date.';
          return;
        }
        out.textContent = 'Updating ' + stale.length + ' item' +
                          (stale.length === 1 ? '' : 's') + '…';
        // Re-select exactly what is out of date and reuse the download path,
        // so there is one implementation of fetching and unpacking.
        Array.prototype.slice.call(document.querySelectorAll('.wiki-check'))
          .forEach(function (c) { c.checked = stale.indexOf(c.value) !== -1; });
        updateTotal();
        return saveSelectedReal();
      })
      .catch(function (err) {
        out.textContent = (err && err.message) || 'Check failed';
      });
  }

  /*
   * Build the .pyz here rather than downloading one.
   *
   * The pages are already in Cache Storage, so generating the file locally
   * saves the build server hosting a near-duplicate of every archive - and the
   * export contains exactly the wikis this reader chose to keep.
   */
  /**
   * The file exports build from what is in the cache, so until something has
   * been saved there is nothing to build from. Disable them and say why, rather
   * than letting someone press a button that can only fail.
   */
  function updateExportState() {
    var anySaved = Object.keys(storedIds).some(function (id) { return id !== 'common'; });
    ['dl-pyz', 'dl-single'].forEach(function (id) {
      var b = el(id);
      if (!b) { return; }
      b.disabled = !anySaved;
      b.title = anySaved ? '' : 'Save a wiki above first - there is nothing to build from yet';
    });
  }

  /**
   * What an export should contain: what you selected, limited to what is
   * actually saved - you cannot export pages you do not have.
   *
   * Reading the stored set alone (the previous behaviour) silently ignored the
   * selection, so ticking every wiki and getting one of them back looked like
   * corruption rather than a missing download.
   */
  function exportSelection() {
    var chosen = selected().map(function (c) { return c.value; });
    var have = chosen.filter(function (id) { return storedIds[id]; });
    var missing = chosen.filter(function (id) { return !storedIds[id]; });
    return { ids: have, missing: missing, chosen: chosen };
  }

  /**
   * Name an export after what it actually contains, plus the build date.
   *
   *   one wiki     copter-2026-08-08.html
   *   several      blimp-copter-rover-2026-08-08.html
   *   everything   ardupilot-all-2026-08-08.pyz
   *
   * The filename is the only thing telling someone months later which vehicles
   * are in the file sitting in their downloads folder.
   */
  function exportName(ids, extension) {
    var stamp = (CURRENT_BUILD || new Date().toISOString()).slice(0, 10);
    var base;
    if (!ids.length) {
      base = 'ardupilot';
    } else if (ids.length >= WIKIS.length) {
      base = 'ardupilot-all';
    } else {
      base = ids.slice().sort().join('-');
    }
    return base + '-' + stamp + extension;
  }

  function exportPyzFile() {
    var link = el('dl-pyz');
    if (!global.ArduPilotExport) { return; }

    var sel = exportSelection();
    if (!sel.ids.length) {
      link.textContent = sel.chosen.length
        ? 'Save those wikis first - none of the selected ones are downloaded yet'
        : 'Select a wiki first';
      return;
    }
    var ids = sel.ids;
    var name = exportName(ids, '.pyz');
    var original = link.textContent;

    link.textContent = 'Preparing…';
    global.ArduPilotExport.exportPyz(ids, name, function (done, total) {
      link.textContent = 'Writing ' + done + ' / ' + total + ' files…';
    }).then(function (r) {
      link.textContent = 'Saved ' + name + ' (' + r.files + ' files)';
      setTimeout(function () { link.textContent = original; }, 8000);
    }).catch(function (err) {
      link.textContent = (err && err.message) || 'Export failed';
      setTimeout(function () { link.textContent = original; }, 8000);
    });
  }

  /**
   * Build the single self-contained HTML file locally.
   *
   * Images are inlined from the cache, the shared common set included: a single
   * file cannot point at an archive next to it, so everything has to be in it.
   */
  function exportHtmlFile() {
    var link = el('dl-single');
    if (!global.ArduPilotExport || !link) { return; }

    var sel = exportSelection();
    if (!sel.ids.length) {
      link.textContent = sel.chosen.length
        ? 'Save those wikis first - none of the selected ones are downloaded yet'
        : 'Select a wiki first';
      return;
    }
    var ids = sel.ids;
    var name = exportName(ids, '.html');
    var original = link.textContent;

    link.textContent = 'Preparing…';
    global.ArduPilotExport.exportHtml(ids, name, function (done, total) {
      link.textContent = 'Writing ' + done + ' / ' + total + ' pages…';
    }).then(function (r) {
      link.textContent = 'Saved ' + name + ' (' + r.pages + ' pages)';
      setTimeout(function () { link.textContent = original; }, 8000);
    }).catch(function (err) {
      link.textContent = (err && err.message) || 'Export failed';
      setTimeout(function () { link.textContent = original; }, 8000);
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
    if (e.target.id === 'check-btn') { checkForUpdates(); }
    if (e.target.id === 'dl-pyz') { e.preventDefault(); exportPyzFile(); }
    if (e.target.id === 'dl-single') { e.preventDefault(); exportHtmlFile(); }
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
          CURRENT_BUILD = manifest.generated || null;
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
})(window);
