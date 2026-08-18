/*
 * [copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
 *
 * Unpacking a downloaded wiki: a streaming tar reader and the archive fetch.
 *
 * This is a small, self-contained library. It knows how to turn one .tar.gz
 * download into cache entries and nothing else: no UI, no state, no knowledge
 * of which wikis exist. The panel (common_offline_page.js) calls it and passes
 * in everything it needs. Split out of the panel so each file stays short
 * enough to skim.
 *
 * Exposes window.ApUnpack:
 *   mimeFor(name)                     -> a Content-Type for a filename
 *   untarToCache(stream, cache, prefix, onEntry)  -> unpack a tar stream
 *   fetchArchive(entry, cache, onBytes, opts)     -> download + unpack one wiki
 *
 * The archive is served as a gzip content coding (nginx gzip_static pairs
 * <name>.tar with <name>.tar.gz), so the browser decompresses before we see a
 * byte and no DecompressionStream is needed - which is what keeps this working
 * on Safari and Firefox versions that lack that API.
 */
(function (global) {
  'use strict';

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
   * simple enough to walk directly - and doing so avoids shipping an archive
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

    // A name carried over from a PAX or GNU long-name header, applied to the
    // very next file entry. Python's tarfile defaults to PAX, which stores any
    // name longer than the 100-byte header field in a preceding ././@PaxHeader
    // record (type 'x') and truncates the field itself. Reading only the field
    // stored those pages under a chopped key, unreachable offline and never
    // repaired because the file table still held the full name. Measured: one
    // page per wiki (the longest title) was lost this way.
    var override = null;

    // Pull "path=<value>" out of a PAX extended header body. Records are
    // "<length> key=value\n"; only path matters here.
    function paxPath(body) {
      var text = '';
      for (var i = 0; i < body.length; i++) { text += String.fromCharCode(body[i]); }
      var m = text.match(/\d+ path=([^\n]*)\n/);
      return m ? m[1] : null;
    }

    function step() {
      return need(512).then(function (ok) {
        if (!ok) { return; }
        var header = take(512);
        var name = textField(header, 0, 100);
        if (!name) { return step(); }   // zero block: padding between members

        // ustar stores an extra 155-byte prefix; a full path is prefix + '/' +
        // name when the prefix is set. PAX/GNU overrides win over both.
        var pfx = textField(header, 345, 155);
        if (pfx) { name = pfx + '/' + name; }

        var size = parseInt(textField(header, 124, 12).trim(), 8) || 0;
        var type = String.fromCharCode(header[156] || 48);
        var padded = Math.ceil(size / 512) * 512;

        return need(padded).then(function (haveBody) {
          if (!haveBody) { return; }
          var body = take(padded).slice(0, size);

          // A PAX extended header ('x'/'g') or GNU long name ('L') names the
          // NEXT entry. Capture it and read on rather than storing anything.
          if (type === 'x' || type === 'g') {
            var p = paxPath(body);
            if (p) { override = p; }
            return step();
          }
          if (type === 'L') {
            override = textField(body, 0, body.length);
            return step();
          }

          // '0' and NUL are regular files; skip directories and other metadata.
          if (type !== '0' && type !== '\0') { override = null; return step(); }

          var entryName = override || name;
          override = null;
          var path = prefix + entryName;
          return storeEntry(cache, path, entryName, body).then(function () {
            if (onEntry) { onEntry(path); }
            return step();
          });
        });
      });
    }

    return step();
  }


  /*
   * Cache Storage holds what you put in it, uncompressed.
   *
   * The archives arrive as .tar.gz, so the DOWNLOAD was never the problem;
   * unpacking is what costs. Measured across all twelve archives: 454.8 MB of
   * html, js, css and search indexes against 711.5 MB of images that are
   * already jpeg and png and cannot be squeezed further. Stored as they came
   * out of the tar that is 1,166 MB, which is past the 1.0 GB WebKit reports
   * as its quota. Gzipping just the text takes it to 769 MB.
   *
   * So text goes in compressed and the service worker inflates it on the way
   * out. Images go in untouched, because spending CPU on both ends to save
   * nothing would be worse than doing nothing.
   *
   * AP_ENCODED marks the ones that need inflating. A header rather than a
   * naming convention, because the key has to stay the real page URL for the
   * worker to find it, and rather than "compress anything that looks like
   * text" because the reader of a cache entry should not have to guess what
   * the writer decided.
   */
  var AP_ENCODED = 'x-ap-encoding';
  var COMPRESSIBLE = /\.(html?|js|mjs|css|json|svg|xml|txt|inv|map)$/i;

  function canCompress() {
    return typeof CompressionStream === 'function';
  }

  function gzip(bytes) {
    var stream = new Response(bytes).body
      .pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  /**
   * Write one entry, compressed when that is worth doing.
   *
   * Falls back to storing the bytes as they are whenever anything is not
   * right: no CompressionStream (nothing shipping supports service workers
   * and not this, but the check is free), or the compressed form came out no
   * smaller. A reader must never end up with an entry that cannot be read
   * back, so every failure path here stores the plain bytes.
   */
  function storeEntry(cache, path, entryName, body) {
    var type = mimeFor(entryName);
    var plain = function () {
      return cache.put(new Request(path),
        new Response(body, { headers: { 'Content-Type': type } }));
    };
    if (!canCompress() || !COMPRESSIBLE.test(entryName) || body.length < 1024) {
      return plain();
    }
    return gzip(body).then(function (packed) {
      if (!packed || packed.byteLength >= body.length) { return plain(); }
      var headers = { 'Content-Type': type };
      headers[AP_ENCODED] = 'gzip';
      return cache.put(new Request(path), new Response(packed, { headers: headers }));
    }).catch(plain);
  }


  /*
   * Read an entry back, inflating it if it was stored compressed.
   *
   * Everything that reads these caches has to come through here or through the
   * service worker's copy of it. The exporter reads them directly to build the
   * single-file HTML, and a gzip body handed to .text() produces mojibake
   * rather than an error, so a missed call site would corrupt an export
   * silently rather than fail.
   */
  function inflate(response) {
    if (!response || !response.headers ||
        response.headers.get(AP_ENCODED) !== 'gzip') {
      return response;
    }
    if (typeof DecompressionStream !== 'function') { return undefined; }
    var headers = new Headers(response.headers);
    headers.delete(AP_ENCODED);
    return new Response(
      response.body.pipeThrough(new DecompressionStream('gzip')),
      { status: 200, statusText: 'OK', headers: headers }
    );
  }

  /** cache.match, but readable. */
  function readFrom(cache, path) {
    return cache.match(path).then(inflate);
  }

  /**
   * Fetch one archive and unpack it into `cache`, reporting bytes received.
   *
   * opts.base   where the archives are served from (ARTIFACT_BASE)
   * opts.build  the manifest's build id, tagged onto the URL
   * opts.signal an AbortSignal so a download can be cancelled
   *
   * Common images are written under /_common/ so they are stored once; the
   * service worker redirects per-wiki image requests there.
   */
  function fetchArchive(entry, cache, onBytes, opts) {
    opts = opts || {};
    // Tagged with the build the manifest describes, so a reader always gets
    // the archive that goes with it. Object storage keeps the same filename
    // every build, and replacing an object does not invalidate the CDN cache
    // in front of it, so without this a new build can be published and readers
    // keep receiving the previous one until the edge decides otherwise. The
    // tag also keeps each build cacheable rather than defeating caching.
    var url = opts.base + '/' + (entry.archive || entry.id + '-offline.tar.gz') +
              (opts.build ? '?v=' + encodeURIComponent(opts.build) : '');
    return fetch(url, { mode: 'cors', signal: opts.signal }).then(function (response) {
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

  global.ApUnpack = {
    mimeFor: mimeFor,
    untarToCache: untarToCache,
    fetchArchive: fetchArchive,
    inflate: inflate,
    readFrom: readFrom
  };
})(typeof self !== 'undefined' ? self : this);
