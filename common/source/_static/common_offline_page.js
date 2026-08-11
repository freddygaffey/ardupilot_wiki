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
  var VERSION = 'verified-bytes-1';
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
      // Chrome's quota accounting lags a deletion by seconds, so immediately
      // after Remove all this said "no wikis saved · 542 MB used", which reads
      // as a failure to delete anything. Measured: still pinned at 568 MB
      // twenty-five seconds after the caches were verifiably gone, and correct
      // on the next load. Say what is happening instead of quoting a number
      // that contradicts the line beside it, and look again shortly.
      var nothingHeld = !savedWikis && !pages && !storedIds.common;
      if (nothingHeld && used > 5 * 1048576) {
        parts.push('freeing space');
        if (!reclaimTimer) {
          reclaimTimer = setTimeout(function () {
            reclaimTimer = null;
            renderStorage();
          }, 3000);
        }
      } else {
        parts.push(fmt(used) + ' used');
      }
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
  // Set while waiting for the browser to finish reclaiming deleted space.
  var reclaimTimer = null;

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


  // ---------------------------------------------------------------------
  // Differential updates.
  //
  // The build writes one table per archive, mapping every archive path to a
  // hash of its contents. Saving stores the table alongside the files. An
  // update then fetches the current table and compares it with the stored one,
  // so only what actually moved is fetched.
  //
  // Nothing is hashed here. The stored table is already an exact record of what
  // was written, so the comparison is table against table, not file against
  // file. That is what keeps this cheap: no reading several hundred megabytes
  // back out of storage to find out what is in it.
  //
  // The alternative, and what this replaces, is re-fetching the whole archive
  // because the site-wide build id moved. That is 439MB to correct a typo.
  // ---------------------------------------------------------------------

  var TABLE_KEY = '/__ap_files__';

  // When more than this has changed, re-download the archive instead of
  // fetching files one by one. See the check in updateStored for the reasoning
  // and the measurement behind these numbers.
  var MAX_DIFF_FILES = 300;
  var MAX_DIFF_FRACTION = 0.2;
  // Below this, a proportion says nothing: two files out of four is half the
  // wiki and also two requests. Only the absolute cap applies to small ones.
  var DIFF_FRACTION_MIN_FILES = 50;

  function tableUrl(entry) {
    return ARTIFACT_BASE + '/' + (entry.files || entry.id + '-files.json') +
           (CURRENT_BUILD ? '?v=' + encodeURIComponent(CURRENT_BUILD) : '');
  }

  function storeTable(cache, table) {
    return cache.put(TABLE_KEY, new Response(JSON.stringify(table), {
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  function readTable(cache) {
    return cache.match(TABLE_KEY).then(function (r) {
      return r ? r.json().catch(function () { return null; }) : null;
    });
  }

  // The unpacker writes common entries under /_common/ and wiki entries under
  // /, so a table key becomes a cache key by the same rule.
  function cacheKeyFor(id, name) {
    return (id === 'common' ? '/_common/' : '/') + name;
  }

  /*
   * Where to fetch a changed file from.
   *
   * A wiki entry is served at its own path. A shared image is not: it is stored
   * once under /_common/, which is a path this site never serves, and is
   * published under each wiki that uses it. Shared means at least two wikis
   * have it, so trying them in turn finds it; the wiki being read is tried
   * first because it is nearly always one of them.
   */
  function sourcesFor(id, name) {
    if (id !== 'common') { return ['/' + name]; }
    var here = location.pathname.split('/')[1];
    var ids = [here].concat(WIKIS.map(function (w) { return w.id; }));
    var seen = {}, out = [];
    ids.forEach(function (w) {
      if (w && !seen[w]) { seen[w] = 1; out.push('/' + w + '/' + name); }
    });
    return out;
  }

  // Requests per second one reader will make while updating. The fetches are
  // sequential, so without a pause this runs as fast as the server answers:
  // measured at about 75 a second, sustained, from a single browser. That is
  // fine for one reader and is a flood from a hundred of them at once.
  var UPDATE_RATE_PER_SEC = 15;
  var lastFetchAt = 0;

  function pace() {
    var gap = 1000 / UPDATE_RATE_PER_SEC;
    var wait = Math.max(0, lastFetchAt + gap - Date.now());
    lastFetchAt = Date.now() + wait;
    return wait ? new Promise(function (r) { setTimeout(r, wait); })
                : Promise.resolve();
  }

  /*
   * Hash of a body, exactly as the build computes it: sha256, first eight
   * bytes, hex (scripts/build_offline_artifacts.py, file_hash). The two must
   * agree byte for byte or every update rejects everything.
   */
  function hashBytes(buf) {
    return crypto.subtle.digest('SHA-256', buf).then(function (d) {
      var v = new Uint8Array(d);
      var out = '';
      for (var i = 0; i < 8; i++) {
        out += (v[i] < 16 ? '0' : '') + v[i].toString(16);
      }
      return out;
    });
  }

  function fetchInto(cache, id, name, expected) {
    // Tagged so the service worker sends it to the network. Without this the
    // worker answers from the cache being refreshed, and the update stores what
    // it already had while reporting that it updated.
    var tag = 'ap-update=' + encodeURIComponent(CURRENT_BUILD || '1');
    var urls = sourcesFor(id, name).map(function (u) {
      return u + (u.indexOf('?') === -1 ? '?' : '&') + tag;
    });
    var key = cacheKeyFor(id, name);
    function attempt(i) {
      if (i >= urls.length) {
        throw new Error('could not fetch ' + name);
      }
      return pace().then(function () {
        return fetch(urls[i], {
          cache: 'no-cache',
          signal: activeDownload ? activeDownload.signal : undefined
        });
      }).then(function (r) {
        // The server asking us to slow down is not a missing file, and trying
        // the next wiki for it would be one more request at exactly the wrong
        // moment. Stop, and let the caller fall back to the archive.
        if (r.status === 429 || r.status === 503) {
          var e = new Error('server is rate limiting updates');
          e.name = 'RateLimited';
          throw e;
        }
        if (!r.ok) { return attempt(i + 1); }
        return r.arrayBuffer().then(function (body) {
          /*
           * The table gave us a hash for this file, so use it. Without this, a
           * 200 with the wrong body - captive portal, error page dressed as
           * 200, mid-deploy skew - was stored verbatim, and then the table was
           * rewritten to say the wiki was healthy. Stored table equalled
           * published table, so no later update could ever see the damage:
           * verified corrupt, permanently, by the exact mechanism built to
           * detect corruption. Observed, not hypothesised: "Updated 1 file"
           * over an HTML body where a script belonged.
           *
           * A mismatch is treated exactly like a failed fetch: try the next
           * source, and if none is right, the update rejects and the archive
           * fallback takes over. Nothing wrong is ever written.
           */
          if (!expected) {
            return cache.put(new Request(key), new Response(body, {
              headers: { 'Content-Type': mimeFor(name) }
            }));
          }
          return hashBytes(body).then(function (got) {
            if (got !== expected) { return attempt(i + 1); }
            return cache.put(new Request(key), new Response(body, {
              headers: { 'Content-Type': mimeFor(name) }
            }));
          });
        });
      }, function (err) {
        if (err && (err.name === 'AbortError' || err.name === 'RateLimited')) {
          throw err;
        }
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  /*
   * Compare stored against published and apply the difference.
   *
   * Resolves with a summary, or null when this wiki was saved before tables
   * existed and there is nothing to compare against, in which case the caller
   * falls back to re-fetching the archive.
   */
  function updateStored(entry, onProgress) {
    var cacheName = OFFLINE_CACHE_PREFIX + entry.id;
    return caches.open(cacheName).then(function (cache) {
      return Promise.all([
        readTable(cache),
        fetch(tableUrl(entry), { cache: 'no-cache' }).then(function (r) {
          if (!r.ok) { throw new Error('could not fetch the file list'); }
          return r.json();
        })
      ]).then(function (both) {
        var stored = both[0], published = both[1];
        if (!stored) { return null; }

        var changed = [], removed = [];
        Object.keys(published).forEach(function (k) {
          if (stored[k] !== published[k]) { changed.push(k); }
        });
        Object.keys(stored).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(published, k)) {
            removed.push(k);
          }
        });

        /*
         * Past a certain point, fetching the difference is worse than fetching
         * the whole thing again.
         *
         * A content edit touches a handful of files, which is what this path is
         * for: 9 of 1,057 on a real commit. But a change to the layout template
         * or a shared stylesheet rewrites EVERY page, and then the "difference"
         * is the entire wiki, fetched one HTTP request at a time. Measured on a
         * reader with twelve wikis saved after exactly that kind of change:
         * 5,169 requests and 30.9 MB from one browser, where the archives would
         * have been twelve requests.
         *
         * That is not just slow for the reader. Every reader who has saved a
         * wiki does it at once, on the same build, so the site is flooded by
         * its own update mechanism. The archives are large static files a CDN
         * serves happily; thousands of small conditional requests are the shape
         * of traffic that hurts.
         *
         * So when too much has moved, give up and say so: returning null puts
         * this wiki back on the ordinary download path, which is one request
         * for one archive.
         */
        var total = Object.keys(published).length || 1;
        if (changed.length > MAX_DIFF_FILES ||
            (total >= DIFF_FRACTION_MIN_FILES &&
             changed.length / total > MAX_DIFF_FRACTION)) {
          return null;
        }

        var done = 0;
        function next(i) {
          if (i >= changed.length) { return Promise.resolve(); }
          return fetchInto(cache, entry.id, changed[i],
                           published[changed[i]]).then(function () {
            done += 1;
            if (onProgress) { onProgress(done, changed.length); }
            return next(i + 1);
          });
        }

        return next(0).then(function () {
          return Promise.all(removed.map(function (k) {
            return cache.delete(new Request(cacheKeyFor(entry.id, k)));
          }));
        }).then(function () {
          // Written only once every file is in place. An interrupted update
          // therefore leaves the previous table and the previous build id, so
          // the wiki still reports itself as the older build rather than as a
          // mixture of two.
          return storeTable(cache, published);
        }).then(function () {
          return cache.put(COMPLETE_MARKER, new Response(JSON.stringify({
            build: CURRENT_BUILD, saved: Date.now(), id: entry.id
          }), { headers: { 'Content-Type': 'application/json' } }));
        }).then(function () {
          return { id: entry.id, changed: changed.length, removed: removed.length };
        });
      });
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
                // Store the file table beside the files it describes, so a
                // later update can compare against exactly what was written
                // here. A failure to fetch it is not fatal: the wiki is
                // complete and usable, and the next update falls back to
                // re-fetching the archive, which is what happened before
                // tables existed.
                return fetch(tableUrl(entry), { cache: 'no-cache' })
                  .then(function (r) { return r.ok ? r.json() : null; })
                  .then(function (table) {
                    return table ? storeTable(cache, table) : null;
                  })
                  .catch(function () { return null; });
              }).then(function () {
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
  function checkForUpdates(quiet) {
    var out = el('check-result');

    // An automatic run says nothing until it has something worth saying.
    // Printing "Checking…" over the panel every half minute would be noise,
    // and worse, it would look like the page was acting on an instruction the
    // reader had not given. News - that an update is being applied, or that it
    // was - is announced either way.
    function announce(text) { out.hidden = false; out.textContent = text; }
    var report = quiet ? function () {} : announce;

    report('Checking…');

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
          report('Up to date.');
          return;
        }
        // Real news: something moved, and pages the reader is holding are
        // about to change under them. Said out loud even on an automatic run.
        announce('Updating ' + stale.length + ' item' +
                 (stale.length === 1 ? '' : 's') + '…');

        // Try the differential path first: compare the stored file table with
        // the published one and fetch only what moved. Anything saved before
        // tables existed has nothing to compare against and resolves null, and
        // those fall back to re-fetching the whole archive.
        var byId = {};
        [COMMON].concat(WIKIS).forEach(function (w) { byId[w.id] = w; });

        var moved = 0, full = [];
        return stale.reduce(function (chain, id) {
          return chain.then(function () {
            var entry = byId[id];
            if (!entry) { full.push(id); return; }
            return updateStored(entry, function (done, total) {
              announce('Updating ' + entry.name + ' · ' +
                       done + ' of ' + total + ' files…');
            }).then(function (result) {
              if (!result) { full.push(id); return; }
              moved += result.changed + result.removed;
            }, function () {
              full.push(id);
            });
          });
        }, Promise.resolve()).then(function () {
          if (!full.length) {
            if (moved) {
              announce('Updated ' + moved + ' file' + (moved === 1 ? '' : 's') + '.');
            } else {
              report('Already up to date.');
            }
            return renderWikis();
          }
          /*
           * The cheap path could not cover these, so what remains is a full
           * archive download, hundreds of megabytes for common alone.
           *
           * On a quiet, timer-driven run that MUST NOT start by itself. It was
           * observed doing exactly that: a background tick, no click anywhere,
           * and the button flipped to Cancel with 439 MB on its way, which on
           * mobile data is an expensive surprise nobody consented to. A
           * download that size is a decision, and decisions belong to the
           * reader: announce that a full refresh is waiting and leave the
           * button armed.
           *
           * A manual press of Check for updates is that consent, and proceeds
           * as before.
           */
          if (quiet) {
            var names = full.map(function (id) {
              return (byId[id] && byId[id].name) || id;
            });
            announce('A full download is needed to update ' +
                     names.join(', ') +
                     '. Press Check for updates to start it.');
            return renderWikis();
          }

          // Re-select what could not be updated differentially and reuse the
          // download path, so there is one implementation of fetching and
          // unpacking.
          selectable().forEach(function (c) {
            c.checked = full.indexOf(c.value) !== -1;
          });
          syncSelectAll();
          updateTotal();
          updateExportState();
          updateSaveState();
          // The one caller allowed to re-fetch what is already stored.
          return saveSelectedReal(full);
        });
      })
      .catch(function (err) {
        // A failed automatic check is ordinary: it means the reader is offline,
        // which is the situation this whole feature exists for. Only a check
        // somebody asked for reports that it could not be done.
        report((err && err.message) || 'Check failed');
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

  /* ---------------------------------------------------------------------
   * Automatic updates.
   *
   * The checkbox below the table has always been there and has always been
   * ticked, and nothing ever read it: "Update saved pages automatically" was a
   * promise the page did not keep. A saved wiki changed only when somebody
   * thought to press Check, which is precisely the thing a reader who saved a
   * wiki months ago will not do.
   *
   * A check that finds nothing costs one request for the manifest, a few
   * hundred bytes, and no more: file tables are fetched only for wikis whose
   * recorded build id has actually moved. That is what makes it reasonable to
   * do this on a timer rather than only on demand.
   * --------------------------------------------------------------------- */

  // Thirty minutes, jittered +/-50% by the scheduler, so a reader's cost is a
  // few hundred bytes an hour and a rebuild reaches saved copies within the
  // hour. The wiki is rebuilt a few times a day at most, so anything tighter
  // buys nothing and multiplies manifest traffic by every open tab. During
  // development this was 30 seconds; that value must not ship, because with
  // eleven wikis' worth of panels able to run their own timers it is a
  // manifest request every few seconds per reader.
  var AUTOUPDATE_MS = 30 * 60 * 1000;

  var autoTimer = null;
  var autoBusy = false;

  function autoUpdateOn() {
    var box = el('autoupdate');
    return !!(box && box.checked);
  }

  function autoUpdateTick() {
    if (!autoUpdateOn()) { return; }
    // A check already running, or a download in progress, owns the panel and
    // the network until it is done. Overlapping runs would fight over the same
    // caches and report over each other.
    if (autoBusy || activeDownload) { return; }
    // Nothing saved means nothing to update and no reason to touch the network.
    if (!Object.keys(storedIds).length) { return; }
    // Deliberately NOT skipped while the tab is hidden. Browsers already
    // throttle timers in background tabs, so a guard here buys nothing they
    // are not doing, and it costs the common case: a wiki left open in a
    // background tab for hours is exactly the copy most likely to be behind.
    // Skipping it meant a reader could leave this page open all day and have
    // "Update saved pages automatically" do nothing at all, which was measured
    // rather than reasoned about: with the guard in place a rebuild published
    // mid-session was never picked up, and the request log stayed empty.

    autoBusy = true;
    return checkForUpdates(true).then(function () { autoBusy = false; },
                                      function () { autoBusy = false; });
  }

  /*
   * Spread readers out, so a new build is not a stampede.
   *
   * On a fixed interval every reader polls in lockstep, discovers the same new
   * build inside the same window, and starts fetching at the same moment. That
   * is the shape of a self-inflicted denial of service: the trigger is not an
   * attacker but somebody editing a layout template, which rewrites every page
   * and puts every saved copy into a full refresh at once.
   *
   * Measured from one browser with twelve wikis saved after exactly that kind
   * of change: 5,169 requests and 30.9 MB, sequential, so about 75 requests a
   * second sustained for a minute. A hundred readers doing that together is
   * 7,500 requests a second at the origin.
   *
   * So each tick is scheduled independently with up to +/-50% jitter. The
   * average rate is unchanged and the herd is smeared across the interval
   * instead of arriving on the same second. The first tick is jittered too, or
   * everyone who opens the page after a deploy lines up again.
   */
  function scheduleNextTick() {
    if (autoTimer) { window.clearTimeout(autoTimer); }
    var jittered = AUTOUPDATE_MS * (0.5 + Math.random());
    autoTimer = window.setTimeout(function () {
      var done = autoUpdateTick();
      if (done && typeof done.then === 'function') {
        done.then(scheduleNextTick, scheduleNextTick);
      } else {
        scheduleNextTick();
      }
    }, jittered);
  }

  function startAutoUpdate() {
    scheduleNextTick();
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
      // Turning it on should mean something now rather than at the next tick.
      if (e.target.checked) { autoUpdateTick(); }
    }
  });

  document.addEventListener('click', function (e) {
    // closest(), not e.target, because these buttons have children. Once armed,
    // Remove all contains its own countdown bar, three pixels tall across the
    // bottom of the button. A click landing on those three pixels reported the
    // bar as the target, matched no id, and was swallowed: the reader pressed
    // the confirm button, in the button, and nothing happened.
    var hit = e.target && e.target.closest &&
              e.target.closest('#clear-btn, #download-cache-btn, #check-btn, #dl-single');
    if (!hit) { return; }
    if (hit.id === 'clear-btn') { confirmClear(); }
    if (hit.id === 'download-cache-btn') { saveSelectedReal(); }
    if (hit.id === 'check-btn') { checkForUpdates(); }
    if (hit.id === 'dl-single') { e.preventDefault(); exportHtmlFile(); }
  });

  function init() {
    try {
      var pref = window.localStorage.getItem(AUTOUPDATE_KEY);
      if (pref === '0') { el('autoupdate').checked = false; }
    } catch (err) { /* private browsing */ }

    startAutoUpdate();
    // A tab left open for hours does nothing while it is hidden, so coming
    // back to it is the moment its copy is most likely to be behind.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { autoUpdateTick(); }
    });

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
