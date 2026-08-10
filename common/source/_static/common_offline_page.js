/*
 * [copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
 *
 * The same destinations as docs/common-offline.rst, deliberately: an asset
 * belongs wherever its page does. Without a marker a .js takes
 * DEFAULT_COPY_WIKIS, which is four of the eleven, so the panel would have
 * been scriptless on seven wikis while looking correct on the four anyone
 * would think to check. (.css is copied to every wiki unconditionally, which
 * is why the stylesheet needs no marker and this does.)
 */
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

  // Bumped when this file changes in a way worth telling apart at runtime.
  // window.ArduPilotOfflineVersion answers "is the page running the code I just
  // deployed?" without inferring it from behaviour.
  var VERSION = 'save-skips-stored-1';
  global.ArduPilotOfflineVersion = VERSION;


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
  // Same origin as the pages, which is what the archives are: ordinary static
  // files in the built tree, written to <destdir>/offline/ by update.py
  // --offline and served by nginx like any other file. There is no endpoint
  // and no separate host.
  //
  // That also means no CORS, no bucket whose policy pins a hostname, and no
  // upload client for objects over 300 MiB. The previous default was a
  // throwaway r2.dev bucket, rate limited and documented as development-only,
  // which a build could ship silently.
  //
  // The manifest's "artifact_base" still overrides this when the archives are
  // genuinely served from elsewhere.
  var ARTIFACT_BASE = '/offline';

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
      var used = est.usage || 0;

      // Two different things get called "saved" and they contradict each other:
      // wikis you deliberately downloaded, and pages cached simply because you
      // read them. The table shows the first, so the footer reporting the
      // second as "saved" made "Remove all" look enabled with nothing to
      // remove. Name them separately.
      var savedWikis = Object.keys(storedIds).filter(function (id) {
        return id !== 'common';
      }).length;
      var parts = [];
      parts.push(savedWikis
        ? savedWikis + ' wiki' + (savedWikis === 1 ? '' : 's') + ' saved'
        : 'no wikis saved');
      if (pages) {
        parts.push(pages + ' page' + (pages === 1 ? '' : 's') + ' cached while reading');
      }
      parts.push(fmt(used) + ' used');
      // Free space is not reported. Browsers return a fuzzed quota that is
      // theirs to revise, not a disk figure, and every wiki here fits inside
      // it comfortably, so the number invited a comparison worth nothing.
      // checkRoom still uses the quota before a download; it is just not
      // something to put on screen.
      parts.push('storage ' + (persisted ? 'permanent' : 'temporary'));
      el('storage-status').textContent = parts.join(' · ');

      // No button: browsers routinely decline a bare persist() request, so it
      // appeared to do nothing. Installing is the signal they do act on.
      el('storage-warning').innerHTML = persisted
        ? ''
        : '<div class="apo-note apo-note-warn">&#9888; Storage is ' +
          '<strong>temporary</strong>. Your browser can delete these saved pages ' +
          'without warning if this device runs low on space. Installing the wiki ' +
          'as an app makes that less likely. ' +
          '<a href="#install-as-an-app" data-ap-install>Install it now</a>, ' +
          'or read what that means below.</div>';

      // Nothing cached means nothing to remove, so the button should not invite
      // a press. Disarm it too, in case it was armed when the last of it went.
      var clear = el('clear-btn');
      if (clear) {
        var anything = pages > 0 || Object.keys(storedIds).length > 0;
        clear.disabled = !anything;
        clear.title = anything ? 'Removes saved wikis and pages cached while reading'
                               : 'Nothing is stored on this device';
        if (!anything && clearArmed) { disarmClear(clear); }
      }

      updateExportState();
      updateSaveState();
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
                 '<td class="apo-num apo-pages">' + (w.pages || '') + '</td>' +
                 // Rendered from state, not painted on afterwards: renderWikis
                 // rebuilds this tbody when a download finishes, which used to
                 // wipe the bar the moment it reached 100%.
                 '<td class="apo-num"><div class="apo-progress"' +
                   (isStored ? '' : ' hidden') + '>' +
                   '<div class="apo-progress-bar" style="width:' +
                     (isStored ? '100%' : '0') + '"></div>' +
                   '<span>' + (isStored ? '100%' : '') + '</span></div></td>' +
                 '<td class="apo-num">' + badge + '</td>' +
               '</tr>';
      });
      el('wiki-rows').innerHTML = rows.join('');

      var clear = el('clear-btn');
      if (clear) {
        var anySaved = Object.keys(stored).length > 0;
        if (anySaved) { clear.disabled = false; clear.title = ''; }
      }

      syncSelectAll();
      updateExportState();
      updateSaveState();
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

  function selectable() {
    return Array.prototype.slice.call(document.querySelectorAll('.wiki-check'));
  }

  /**
   * Mirror the rows: ticked when every wiki is, indeterminate when only some
   * are. Common is excluded, its box being required and disabled.
   */
  function syncSelectAll() {
    var box = el('select-all');
    if (!box) { return; }
    var all = selectable().length;
    var on = selected().length;
    box.checked = all > 0 && on === all;
    box.indeterminate = on > 0 && on < all;
    box.disabled = all === 0;
  }

  function toggleAll(on) {
    selectable().forEach(function (c) { c.checked = on; });
    syncSelectAll();
    updateTotal();
    updateExportState();
    updateSaveState();
  }

  function updateTotal() {
    var b = selectionBytes();
    var total = el('selection-total');
    if (!total) { return; }

    // Kept short: this sits in a right-aligned column barely wider than the
    // checkbox beside it, and a sentence long enough to wrap reads badly there.
    if (!b.total) {
      total.textContent = 'Nothing selected';
    } else if (!b.toDownload) {
      total.innerHTML = '<strong>' + fmt(b.total) + '</strong> selected, ' +
                        'all already saved';
    } else {
      total.innerHTML = '<strong>' + fmt(b.toDownload) + '</strong> to download' +
                        (b.toDownload === b.total ? '' :
                          ' &middot; ' + fmt(b.total - b.toDownload) + ' of ' +
                          fmt(b.total) + ' already saved');
    }
  }

  /* ---------- actions ---------- */

  /**
   * Removing is destructive and slow to undo - it discards hundreds of
   * megabytes somebody chose to keep, and getting them back means downloading
   * them again, possibly without the connection that made it possible.
   *
   * So it asks first, in place rather than through a modal, and says how much
   * is at stake. It reverts on its own if left alone, so a stray click cannot
   * arm it indefinitely.
   */
  var CONFIRM_MS = 6000;
  // A double click should never delete anything. The second press is ignored
  // until this has passed, so confirming has to be a deliberate, separate act.
  var CONFIRM_DEAD_MS = 700;

  var clearArmed = null;
  var clearArmedAt = 0;

  function disarmClear(btn) {
    if (clearArmed) { clearTimeout(clearArmed); }
    clearArmed = null;
    btn.textContent = 'Remove all';
    // Stays red: it is destructive whether or not it is armed. Arming is
    // signalled by the label, the darker shade and the draining bar.
    btn.classList.remove('apo-btn-armed');
    var bar = btn.querySelector('.apo-arm');
    if (bar) { bar.remove(); }
  }

  function confirmClear() {
    var btn = el('clear-btn');
    if (!btn) { return; }

    if (clearArmed) {
      if (Date.now() - clearArmedAt < CONFIRM_DEAD_MS) { return; }
      disarmClear(btn);
      return clearAll();
    }

    return storage().then(function (r) {
      var used = (r.estimate || {}).usage || 0;
      btn.textContent = used ? 'Delete ' + fmt(used) + '? Press again'
                             : 'Press again to confirm';
      btn.classList.add('apo-btn-armed');

      var bar = document.createElement('span');
      bar.className = 'apo-arm';
      btn.appendChild(bar);
      // Force a layout so the transition starts from full width rather than
      // being collapsed into the same frame.
      void bar.offsetWidth;
      bar.style.transitionDuration = CONFIRM_MS + 'ms';
      bar.classList.add('apo-arm-run');

      clearArmedAt = Date.now();
      clearArmed = setTimeout(function () { disarmClear(btn); }, CONFIRM_MS);
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
          // Escaped, not a raw byte, or the file reads as binary to grep.
          if (type !== '0' && type !== '\0') { return step(); }
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
    // Tagged with the build the manifest describes, so a reader always gets
    // the archive that goes with it. Object storage keeps the same filename
    // every build, and replacing an object does not invalidate the CDN cache
    // in front of it, so without this a new build can be published and readers
    // keep receiving the previous one until the edge decides otherwise. The
    // tag also keeps each build cacheable rather than defeating caching.
    var url = ARTIFACT_BASE + '/' + (entry.archive || entry.id + '-offline.tar.gz') +
              (CURRENT_BUILD ? '?v=' + encodeURIComponent(CURRENT_BUILD) : '');
    return fetch(url, {
      mode: 'cors',
      signal: activeDownload ? activeDownload.signal : undefined
    }).then(function (response) {
      if (!response.ok) {
        throw new Error('could not fetch ' + entry.name + ' (' + response.status + ')');
      }
      if (!response.body) {
        throw new Error('this browser cannot stream the download');
      }

      var counter = new TransformStream({
        transform: function (chunk, controller) {
          onBytes(chunk.byteLength);
          controller.enqueue(chunk);
        }
      });

      // No DecompressionStream. The archive is served as a content coding
      // (nginx gzip_static pairs <name>.tar with <name>.tar.gz), so the
      // browser has already decompressed by the time we see the body. That
      // drops a dependency which excluded Safari below 16.4 and Firefox below
      // 113, and removes a pipe stage.
      //
      // The bytes counted here are therefore DECOMPRESSED, which is why the
      // manifest carries raw_bytes alongside the compressed size: measuring
      // progress against Content-Length would read over 200% on the
      // text-heavy wikis.
      var stream = response.body.pipeThrough(counter);

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

  /**
   * Download what is selected and not already held.
   *
   * `refreshIds` re-fetches something already stored; only the update check
   * passes it. Without that filter a second press re-fetched every selected
   * wiki, several hundred megabytes, to end up where it started.
   */
  function saveSelectedReal(refreshIds) {
    // A several-hundred-megabyte download has to be stoppable. The same button
    // becomes Cancel rather than adding a second one that is dead most of the
    // time.
    if (activeDownload) { return cancelDownload(); }

    var refresh = refreshIds || [];
    var chosen = selected().map(function (c) { return c.value; });
    var queue = [COMMON].concat(WIKIS.filter(function (w) {
      return chosen.indexOf(w.id) !== -1;
    })).filter(function (w) {
      return !storedIds[w.id] || refresh.indexOf(w.id) !== -1;
    });

    if (!queue.length) {
      el('cache-progress').hidden = false;
      el('cache-progress').textContent =
        'Everything selected is already saved. Use Check for updates to refresh it.';
      return Promise.resolve();
    }

    var totalBytes = queue.reduce(function (a, w) {
      return a + (w.mb || 0) * 1048576;
    }, 0);

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
              // raw_bytes, not mb: the browser decompresses before we count,
              // so the stream is larger than the download.
              var entryBytes = entry.raw_bytes || (entry.mb || 0) * 1048576;
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
              }).then(function () {
                // One source of truth, updated the moment it becomes true.
                //
                // The rows were painted live as each archive landed while the
                // footer was computed from a snapshot taken at page load and
                // refreshed only when the whole queue finished. Mid-download
                // the panel said every row was Saved and, on the same screen,
                // that no wikis were saved and the full 696 MB was still to
                // download. Both readings came from the same run.
                storedIds[entry.id] = true;
                return renderStorage();
              });
            });
          });
        }, Promise.resolve());
      })
      .then(function () { report('Saved'); })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          report('Cancelled. Anything already saved is kept.');
        } else if (err && err.name === 'QuotaExceededError') {
          report('Ran out of space. Your existing copy is untouched.');
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
            // The cache is named for the wiki it holds, so the id is known
            // without reading anything. The marker names it too, but a marker
            // that is unreadable or from an older format would otherwise leave
            // that wiki permanently stuck: it reports itself up to date, and
            // no update ever selects it.
            var id = name.slice(OFFLINE_CACHE_PREFIX.length).split('-')[0];
            return caches.open(name).then(function (c) {
              return c.match(COMPLETE_MARKER).then(function (m) {
                if (!m) { return null; }
                return m.json().then(function (info) {
                  return (info.build && info.build !== CURRENT_BUILD)
                    ? (info.id || id) : null;
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
        selectable().forEach(function (c) {
          c.checked = stale.indexOf(c.value) !== -1;
        });
        syncSelectAll();
        updateTotal();
        updateExportState();
        updateSaveState();
        // The one caller allowed to re-fetch what is already stored.
        return saveSelectedReal(stale);
      })
      .catch(function (err) {
        out.textContent = (err && err.message) || 'Check failed';
      });
  }

  /*
   * Build the file here rather than downloading one.
   *
   * The pages are already in Cache Storage, so generating it locally saves the
   * build server hosting a near-duplicate of every archive, and the export
   * contains exactly the wikis this reader chose to keep.
   */
  /**
   * Export buttons act on the selection directly: anything selected but not yet
   * saved is downloaded first, then the file is built. Requiring two separate
   * presses to get one file was needless ceremony.
   */
  /** Save is offered only when it has something to fetch. */
  function updateSaveState() {
    var button = el('download-cache-btn');
    if (!button || activeDownload) { return; }
    var b = selectionBytes();
    // Common alone is images with no pages to view them in.
    var anyWiki = selected().length > 0;
    button.disabled = !anyWiki || !b.toDownload;
    button.title = !anyWiki
      ? 'Select a wiki first'
      : (b.toDownload
          ? 'Downloads ' + fmt(b.toDownload)
          : 'Everything selected is already saved. Check for updates refreshes it.');
  }

  function updateExportState() {
    var chosen = selected().length;
    var b = el('dl-single');
    if (!b) { return; }
    b.disabled = !chosen;
    b.title = chosen ? '' : 'Select at least one wiki first';
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
   *   everything   ardupilot-all-2026-08-08.html
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

  /**
   * Build a file from the selection.
   *
   * Anything selected but not yet saved is downloaded first, then the file is
   * built from the cache. One press, not two: needing to save and then export
   * as separate steps was ceremony with no purpose.
   */
  function buildExport(buttonId) {
    var link = el(buttonId);
    if (!link || !global.ArduPilotExport || !selected().length) { return; }

    var original = link.dataset.label || link.textContent;
    link.dataset.label = original;
    link.disabled = true;

    var done = function (text, keep) {
      link.textContent = text;
      link.disabled = false;
      if (!keep) { setTimeout(function () { link.textContent = original; }, 8000); }
    };

    var sel = exportSelection();
    link.textContent = sel.missing.length
      ? 'Saving ' + sel.missing.join(', ') + '…'
      : 'Preparing…';

    var first = sel.missing.length ? saveSelectedReal() : Promise.resolve();

    return first.then(function () {
      var ready = exportSelection();
      if (!ready.ids.length) {
        throw new Error('Nothing was saved - check your connection');
      }
      var name = exportName(ready.ids, '.html');
      return global.ArduPilotExport.exportHtml(ready.ids, name,
        function (n, total) {
          link.textContent = 'Writing ' + n + ' / ' + total + ' pages…';
        }).then(function (r) {
          done('Saved ' + name + ' (' + r.pages + ' pages)');
        });
    }).catch(function (err) {
      done((err && err.message) || 'Export failed');
    });
  }

  function exportHtmlFile() { return buildExport('dl-single'); }

  /* ---------- wiring ---------- */

  document.addEventListener('change', function (e) {
    if (e.target.classList.contains('wiki-check')) {
      syncSelectAll();
      updateTotal();
      // Clearing the last tick otherwise left the export buttons enabled
      // until the next render.
      updateExportState();
      updateSaveState();
    }
    if (e.target.id === 'select-all') { toggleAll(e.target.checked); }
    if (e.target.id === 'autoupdate') {
      try {
        window.localStorage.setItem(AUTOUPDATE_KEY, e.target.checked ? '1' : '0');
      } catch (err) { /* private browsing */ }
    }
  });

  document.addEventListener('click', function (e) {
    if (e.target.id === 'clear-btn') { confirmClear(); }
    if (e.target.id === 'download-cache-btn') { saveSelectedReal(); }
    if (e.target.id === 'check-btn') { checkForUpdates(); }
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

    // Draw straight away from the built-in list. Waiting for the manifest left
    // an empty table on screen for as long as the request took, so the panel
    // arrived visibly later than the page around it. The numbers are corrected
    // a moment later when the manifest lands; the shape of the thing does not
    // have to wait for them.
    renderStorage();
    renderWikis();

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
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
