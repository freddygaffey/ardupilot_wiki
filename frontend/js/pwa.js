/*
 * PWA glue: registers the service worker, drives an explicit install button
 * (the browser's own banner is suppressed and install offered only on our
 * button), and surfaces page updates. Loaded from the theme and the frontend
 * pages, so it must cope with the button being absent.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) {
    return;
  }

  var INSTALL_BUTTON_ID = 'ap-install-app';
  var INSTALLABLE_KEY = 'ap-installable';
  var deferredPrompt = null;
  var promptArrived = null;
  var signalPromptArrived = null;

  promptArrived = new Promise(function (resolve) {
    signalPromptArrived = resolve;
  });

  function remember(installable) {
    try {
      if (installable) {
        window.localStorage.setItem(INSTALLABLE_KEY, '1');
      } else {
        window.localStorage.removeItem(INSTALLABLE_KEY);
      }
    } catch (err) {
      /* private browsing; the button simply reverts to appearing late */
    }
  }

  function wasInstallable() {
    try {
      return window.localStorage.getItem(INSTALLABLE_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function installButton() {
    return document.getElementById(INSTALL_BUTTON_ID);
  }

  function showInstallButton() {
    var button = installButton();
    if (button) {
      button.hidden = false;
    }
  }

  function hideInstallButton() {
    var button = installButton();
    if (button) {
      button.hidden = true;
    }
  }

  // Registered as early as possible: 'beforeinstallprompt' can fire before a
  // deferred script would have had a chance to attach a listener.
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    remember(true);
    signalPromptArrived();
    showInstallButton();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    remember(false);
    hideInstallButton();
  });

  // Anything marked data-ap-install offers to install, not just the button.
  // The storage warning links here too, and sending a reader who asked to
  // install down the page to find a button is a worse answer than the dialog
  // they were asking for. The button stays where it is for anyone who scrolls.
  var INSTALL_SELECTOR = '#' + INSTALL_BUTTON_ID + ', [data-ap-install]';

  document.addEventListener('click', function (event) {
    var target = event.target.closest ? event.target.closest(INSTALL_SELECTOR) : null;
    if (!target) {
      return;
    }
    // A link would otherwise jump the page before the dialog is decided.
    if (target.tagName === 'A') {
      event.preventDefault();
    }

    // The button may be on screen before beforeinstallprompt has fired, because
    // we show it straight away when this site was installable on a previous
    // visit. If it is clicked in that window, wait briefly for the event rather
    // than doing nothing - a button that ignores the first click is worse than
    // one that appears late.
    var ready = deferredPrompt
      ? Promise.resolve()
      : Promise.race([
          promptArrived,
          new Promise(function (resolve) { setTimeout(resolve, 2000); }),
        ]);

    var isButton = target.tagName === 'BUTTON';
    if (isButton) { target.disabled = true; }
    ready.then(function () {
      if (isButton) { target.disabled = false; }
      if (!deferredPrompt) {
        // It never arrived, so this browser will not install it after all.
        remember(false);
        hideInstallButton();
        // A link that offered to install and then did nothing is worse than
        // one that takes you to the section explaining it, so fall back to
        // whatever the link pointed at.
        var href = !isButton && target.getAttribute('href');
        if (href && href.charAt(0) === '#') { window.location.hash = href; }
        return;
      }
      deferredPrompt.prompt();
      return deferredPrompt.userChoice.then(function (choice) {
        if (choice.outcome === 'accepted') {
          hideInstallButton();
        }
        // The event is single use whatever the reader chose.
        deferredPrompt = null;
      });
    });
  });

  /*
   * The service worker serves a cached page immediately and refreshes it in the
   * background. When the refreshed copy differs from what was rendered we say
   * so rather than silently swapping it: a reader mid-paragraph should not have
   * the page change underneath them, and someone who has just edited a page
   * wants to know their change is live.
   */
  function showUpdateToast() {
    if (document.getElementById('ap-update-toast')) {
      return;
    }
    var toast = document.createElement('div');
    toast.id = 'ap-update-toast';
    toast.setAttribute('role', 'status');
    toast.style.cssText = [
      'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
      'background:#2980b9', 'color:#fff', 'padding:10px 16px', 'border-radius:4px',
      'font-family:sans-serif', 'font-size:14px', 'z-index:9999',
      'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
    ].join(';');
    toast.textContent = 'This page has been updated. ';

    var reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.style.cssText = 'margin-left:8px;background:#fff;color:#2980b9;border:0;' +
                           'padding:4px 10px;border-radius:3px;cursor:pointer';
    reload.addEventListener('click', function () {
      window.location.reload();
    });

    toast.appendChild(reload);
    document.body.appendChild(toast);
  }

  navigator.serviceWorker.addEventListener('message', function (event) {
    if (!event.data) {
      return;
    }
    if (event.data.type === 'PAGE_UPDATED' &&
        event.data.url === window.location.href.split('#')[0]) {
      showUpdateToast();
    }
  });


  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }

  // Show the button immediately when this site was installable last time, so a
  // reload does not visibly pop the button in a second late. If the browser
  // turns out to disagree, the click handler above corrects it.
  document.addEventListener('DOMContentLoaded', function () {
    if (!isStandalone() && wasInstallable()) {
      showInstallButton();
    }
  });

  // The worker is OPT-IN. Nothing registers until the reader asks for offline
  // mode - by the menu control below, or by saving a wiki, both deliberate
  // acts. A reader who never opts in browses the wiki exactly as it was before
  // this feature existed: no worker, no interception, nothing to go wrong.
  // That is also what lets the feature ship to production dormant and be
  // tested there in parallel.
  var OFFLINE_KEY = 'ap-offline-enabled';
  var ENABLE_CONTROL_ID = 'ap-offline-enable';

  function offlineEnabled() {
    try {
      return window.localStorage.getItem(OFFLINE_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function enableOffline() {
    try {
      window.localStorage.setItem(OFFLINE_KEY, '1');
    } catch (err) {
      /* private browsing; the registration below still holds for this tab */
    }
    registerServiceWorker();
    reflectEnableControl();
  }

  // The menu carries an "Enable offline mode" item on every page. Label it
  // honestly on arrival, and make pressing it the switch.
  function reflectEnableControl() {
    var control = document.getElementById(ENABLE_CONTROL_ID);
    if (control && offlineEnabled()) {
      control.textContent = 'Offline mode: on';
    }
  }

  document.addEventListener('click', function (event) {
    var control = event.target.closest ?
        event.target.closest('#' + ENABLE_CONTROL_ID) : null;
    if (!control) { return; }
    event.preventDefault();
    enableOffline();
  });

  // The offline page's Save button opts in too: saving a wiki only to have no
  // worker to serve it offline would be a download that does nothing.
  window.ApOffline = { enabled: offlineEnabled, enable: enableOffline };

  function startWhenOptedIn() {
    reflectEnableControl();
    if (offlineEnabled()) {
      registerServiceWorker();
      return;
    }
    // Enabled on an earlier visit but the flag is gone (site data partially
    // cleared, or a build from before opt-in): the registration itself is the
    // reader's answer, so honour it and restore the flag.
    navigator.serviceWorker.getRegistration().then(function (registration) {
      if (registration) { enableOffline(); }
    }).catch(function () { /* nothing registered, nothing to honour */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWhenOptedIn);
  } else {
    startWhenOptedIn();
  }

  function registerServiceWorker() {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (registration) {
      // Browsers already re-check sw.js on navigation; this makes the check
      // explicit so a fixed worker - or the kill switch in sw-kill.js - reaches
      // installed clients on their next visit rather than eventually. It is one
      // conditional request, normally answered with a 304.
      //
      // It CANNOT succeed offline, which is a state this site is built to be
      // read in, and an uncaught rejection here was one per offline page load:
      // "encountered an error during installation" in Firefox, "Script /sw.js
      // load failed" in WebKit, and intermittently InvalidStateError when the
      // registration changed underneath it. Nothing was broken - the installed
      // worker serves the page either way - but it filled the console of the
      // exact situation a reader would be debugging.
      registration.update().catch(function (err) {
        console.debug('[pwa] worker update check skipped', err && err.name);
      });
    }).catch(function (err) {
      console.warn('[pwa] service worker registration failed', err);
    });

    // Already running as an installed app, so there is nothing to install.
    if (isStandalone()) {
      hideInstallButton();
    }
  }
})();

/*
 * TODO(mirror): delete this when served from ardupilot.org. The wiki links to
 * itself by absolute ardupilot.org URLs in hundreds of places; on a mirror or
 * offline those walk the reader off the site or fail outright. A service worker
 * CANNOT catch it - a cross-origin top-level navigation is never handed to one -
 * so it is caught at click time instead. Only links to a wiki this site serves
 * are rewritten; /discord, /donate, the firmware server and forum leave normally.
 */
(function () {
  'use strict';

  var WIKIS = /^\/(copter|plane|rover|sub|blimp|dev|antennatracker|planner|planner2|ardupilot|mavproxy)(\/|$)/;
  var SITE = /^https?:\/\/(?:www\.)?ardupilot\.org(\/.*)?$/i;

  document.addEventListener('click', function (e) {
    // Leave modified clicks alone: a command-click asking for a new tab should
    // still get the live site, and a middle click is not ours to redirect.
    if (e.defaultPrevented || e.button !== 0) { return; }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) { return; }

    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target === '_blank') { return; }

    var m = SITE.exec(a.href);
    if (!m) { return; }

    var path = m[1] || '/';
    if (!WIKIS.test(path)) { return; }

    e.preventDefault();
    window.location.href = path;
  });
})();


/*
 * Fetch the page the pointer is heading for, just before it arrives. Prefetching
 * every link works but asks the server for dozens of pages to guess at one, so
 * instead watch the pointer, which costs nothing until there is a reason. Three
 * signals, increasing in weight: position (near a link), velocity (its path
 * lands on one), and acceleration (SLOWING as it approaches - people decelerate
 * into a target they mean to hit, which separates intent from traffic).
 */
(function () {
  'use strict';

  var conn = navigator.connection || {};
  if (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '')) {
    return;
  }

  // Hard limits, deliberately conservative: a heuristic that follows an idle
  // pointer around can quietly turn one reader into a load generator.
  var MAX_BYTES = 2 * 1024 * 1024;   // the generated reference pages are 5.8MB
  // An index page can have 500+ links; tracking each means a rect read per link
  // on every scroll and frame. Past this, guess nothing - a reader there is
  // scanning, not being led anywhere.
  var MAX_TRACKED = 250;
  var MAX_PER_PAGE = 5;              // total guesses allowed per page view
  var MIN_GAP_MS = 400;              // never two in quick succession
  var NEAR_PX = 72;                  // close enough to act on by itself
  var LOOKAHEAD_MS = 250;            // how far ahead the path is projected
  var SLOW_PX_MS = 0.25;             // slower than this counts as arriving

  var asked = new Set();
  var spent = 0;
  var lastAt = 0;
  var busy = false;
  var inFlight = null;
  var samples = [];                  // {x, y, t}, newest last
  var rects = null;
  var pending = null;

  function fetchable(a) {
    if (!a || !a.href || a.target === '_blank') { return null; }
    var u;
    try { u = new URL(a.href); } catch (e) { return null; }
    if (u.origin !== location.origin) { return null; }
    if (!/\.html?$|\/$/.test(u.pathname)) { return null; }
    u.hash = '';
    if (u.pathname === location.pathname || asked.has(u.href)) { return null; }
    return u.href;
  }

  // Recomputed on scroll and resize rather than per pointer move: reading
  // layout on every mousemove is exactly how a smooth page starts stuttering.
  var tooMany = false;

  function measure() {
    rects = [];
    var all = document.querySelectorAll('a[href]');
    if (all.length > MAX_TRACKED) { tooMany = true; return; }
    var h = window.innerHeight, w = window.innerWidth;
    // Rects are read in one pass and never interleaved with writes, so this
    // costs one layout rather than one per link.
    [].forEach.call(all, function (a) {
      var href = fetchable(a);
      if (!href) { return; }
      var r = a.getBoundingClientRect();
      if (r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) { return; }
      rects.push({ href: href, r: r });
    });
  }

  function distanceTo(r, x, y) {
    var dx = Math.max(r.left - x, 0, x - r.right);
    var dy = Math.max(r.top - y, 0, y - r.bottom);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function prefetch(href) {
    if (busy || asked.has(href)) { return; }

    // Already held? Nothing to guess at, nothing to spend - the budget and
    // pacing only apply to what would actually reach the server.
    if (window.caches && caches.match) {
      asked.add(href);
      // Exact match, not ignoreSearch: ignoreSearch disables the key hash and
      // walks every cache (300+ ms with a dozen saved wikis, on the main thread,
      // per link). These hrefs have no query and stored keys have none, so exact
      // match finds anything held and is instant.
      caches.match(href).then(function (hit) {
        if (hit) { return; }                 // free, and already done
        asked.delete(href);
        spend(href);
      }).catch(function () { asked.delete(href); spend(href); });
      return;
    }
    spend(href);
  }

  function spend(href) {
    var now = performance.now();
    if (busy || asked.has(href)) { return; }
    if (spent >= MAX_PER_PAGE) { return; }
    if (now - lastAt < MIN_GAP_MS) { return; }

    asked.add(href);
    spent++;
    lastAt = now;
    busy = true;

    // ONE request, not two. Asking HEAD first and then GET doubled the server
    // load of every guess, which is the opposite of the point. The size is in
    // the response headers before the body arrives, so read it there and
    // abandon anything large mid-flight.
    var ctl = new AbortController();
    inFlight = ctl;
    fetch(href, { credentials: 'same-origin', priority: 'low', signal: ctl.signal })
      .then(function (res) {
        var size = Number(res.headers.get('content-length') || 0);
        if (size > MAX_BYTES) {
          ctl.abort();
          return null;
        }
        return res.arrayBuffer();   // let the worker store it, then discard
      })
      .catch(function () { /* a speculative miss costs nothing */ })
      .then(function () { busy = false; inFlight = null; });
  }

  // A guess in flight is worthless the moment the reader goes somewhere, and
  // holding the connection open competes with the page they actually asked for.
  window.addEventListener('pagehide', function () {
    if (inFlight) { inFlight.abort(); }
  });

  function consider() {
    pending = null;
    if (tooMany) { return; }
    if (!rects) { measure(); }
    if (tooMany || !rects.length || samples.length < 3) { return; }

    var n = samples.length;
    var a = samples[n - 3], b = samples[n - 2], c = samples[n - 1];
    var dt1 = Math.max(b.t - a.t, 1), dt2 = Math.max(c.t - b.t, 1);

    // First derivative: where it is going, and how fast.
    var vx = (c.x - b.x) / dt2, vy = (c.y - b.y) / dt2;
    var speed = Math.sqrt(vx * vx + vy * vy);

    // Second derivative: whether it is winding down or still winding up.
    var prevSpeed = Math.sqrt(Math.pow((b.x - a.x) / dt1, 2) +
                              Math.pow((b.y - a.y) / dt1, 2));
    var slowing = speed < prevSpeed;

    // Where it will be shortly, if it carries on as it is.
    var px = c.x + vx * LOOKAHEAD_MS, py = c.y + vy * LOOKAHEAD_MS;

    var best = null, bestScore = 0;
    rects.forEach(function (item) {
      var now = distanceTo(item.r, c.x, c.y);
      var soon = distanceTo(item.r, px, py);

      var score = 0;
      if (now < NEAR_PX) { score += 1; }
      if (soon < now) { score += 1; }                       // heading for it
      if (soon < 12) { score += 1; }                        // path lands on it
      if (slowing && soon < NEAR_PX) { score += 2; }        // arriving at it
      if (speed < SLOW_PX_MS && now < NEAR_PX) { score += 1; }

      if (score > bestScore) { bestScore = score; best = item.href; }
    });

    // Three points, so proximity alone is never enough and neither is
    // proximity plus vague movement toward something. In practice this means
    // the path lands on a link, or the pointer is slowing as it arrives at
    // one. A page costs about 25 KB to guess at, and the reader asked for
    // none of it, so the evidence should be good before spending it.
    if (best && bestScore >= 3) { prefetch(best); }
  }

  document.addEventListener('mousemove', function (e) {
    samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (samples.length > 4) { samples.shift(); }
    if (!pending) { pending = requestAnimationFrame(consider); }
  }, { passive: true });

  // Touch has no approach to read, so the touch is the intent.
  document.addEventListener('touchstart', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    var href = fetchable(a);
    if (href) { prefetch(href); }
  }, { passive: true });

  // Hovering is intent the trajectory predictor cannot see: it reads the path
  // across the page, which catches content links a reader drifts over but not
  // the sidebar, where a reader goes straight there and clicks. Resting on a
  // link briefly is a clear "this one", wherever it is; the 65ms delay keeps a
  // pointer crossing the menu from prefetching everything, on the same budget.
  var hoverTimer = null;
  document.addEventListener('mouseover', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    var href = fetchable(a);
    if (!href) { return; }
    if (hoverTimer) { clearTimeout(hoverTimer); }
    hoverTimer = setTimeout(function () { prefetch(href); }, 65);
  }, { passive: true });
  document.addEventListener('mouseout', function () {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  }, { passive: true });

  // Next and previous are the two likeliest clicks on any documentation page,
  // and there are only ever two of them, so take them without waiting for the
  // pointer to say anything. They count against the same budget as everything
  // else.
  function prefetchNeighbours() {
    var picked = [];
    [].forEach.call(
      document.querySelectorAll('.rst-footer-buttons a[href], a[rel="next"], a[rel="prev"]'),
      function (a) {
        var href = fetchable(a);
        if (href && picked.indexOf(href) === -1) { picked.push(href); }
      });
    // One now, the other once that has finished, so they never race.
    if (picked[0]) { prefetch(picked[0]); }
    if (picked[1]) { setTimeout(function () { prefetch(picked[1]); }, MIN_GAP_MS + 50); }
  }

  if (document.readyState === 'complete') { setTimeout(prefetchNeighbours, 800); }
  else { window.addEventListener('load', function () { setTimeout(prefetchNeighbours, 800); }); }

  var remeasure = null;
  function invalidate() {
    clearTimeout(remeasure);
    remeasure = setTimeout(function () { rects = null; }, 150);
  }
  window.addEventListener('scroll', invalidate, { passive: true });
  window.addEventListener('resize', invalidate, { passive: true });
})();


/*
 * Land on the anchor rather than at the top and then jumping. The reference
 * pages carry content-visibility, so an anchor inside a skipped section cannot
 * be scrolled to yet - the page renders the top, lays out, then snaps a second
 * later. So force the sections containing the target to lay out before scrolling.
 */
(function () {
  'use strict';

  function reveal() {
    if (!location.hash || location.hash.length < 2) { return; }
    var id = decodeURIComponent(location.hash.slice(1));
    var el = document.getElementById(id) ||
             document.getElementsByName(id)[0];
    if (!el) { return; }

    var revealed = false;
    for (var node = el; node && node !== document.body; node = node.parentElement) {
      // Only touch what is actually being skipped.
      if (getComputedStyle(node).contentVisibility === 'auto') {
        node.style.contentVisibility = 'visible';
        node.style.containIntrinsicSize = 'none';
        revealed = true;
      }
    }

    // Only scroll if something was hidden from the browser when it tried.
    //
    // On an ordinary page the browser has already scrolled to the anchor
    // perfectly well, and scrolling again on DOMContentLoaded jumps the page
    // out from under the reader and takes the top menu off screen with it.
    // There is nothing to correct unless we just changed what is laid out.
    if (revealed) { el.scrollIntoView(); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reveal);
  } else {
    reveal();
  }
  window.addEventListener('hashchange', reveal);
})();

/*
 * Bring saved video cards to life when there is a connection. A saved wiki
 * stores a still and a link where the embed was, but that copy is served online
 * too, so a reader with a good connection got the offline compromise. So paint
 * the still instantly and replace it with the real player when the reader is
 * likely to want it, triggered by the card coming into view (via an observer,
 * which catches anchor jumps and find-in-page too) or the pointer entering it.
 * Nothing autoplays; the still stays underneath so there is no flash of empty box.
 */
(function () {
  'use strict';

  var ID = /[?&]v=([\w-]{6,})/;
  function upgrade(a) {
    if (a.dataset.apLive) { return; }
    var m = ID.exec(a.getAttribute('href') || '');
    if (!m) { return; }
    a.dataset.apLive = '1';

    var img = a.querySelector('img');
    var still = img ? img.getAttribute('src') : null;

    var box = document.createElement('div');
    box.className = 'ap-video ap-video-live';
    box.style.cssText = 'position:relative;max-width:640px;margin:1em 0;' +
      'border-radius:4px;overflow:hidden;background:#2f2f2f' +
      (still ? ' url("' + still + '") center/cover no-repeat' : '');

    var ratio = document.createElement('span');
    ratio.style.cssText = 'display:block;padding-bottom:56.25%';

    var frame = document.createElement('iframe');
    frame.src = 'https://www.youtube-nocookie.com/embed/' + m[1] + '?rel=0';
    frame.title = 'YouTube video';
    frame.loading = 'lazy';
    frame.allowFullscreen = true;
    frame.setAttribute('allow',
      'accelerometer; encrypted-media; gyroscope; picture-in-picture');
    // Load HIDDEN, over the still. YouTube's embed takes a few hundred
    // milliseconds to fetch and render, and an iframe is a blank white
    // rectangle until it does - so showing it at once covered the thumbnail
    // with white while it loaded, which is the "slow" flash. Instead the still
    // stays visible and the real player fades in only once it has loaded, so
    // the swap is barely noticeable: thumbnail now, video a moment later.
    frame.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;border:0;' +
      'opacity:0;transition:opacity 0.5s ease';

    frame.addEventListener('load', function () {
      // A hair after the document loads YouTube has painted its poster, so
      // fading in now lands on its thumbnail rather than a blank frame.
      frame.style.opacity = '1';
    });

    // If the embed cannot be reached after all - the connection went away
    // between the check and the load - put the card back rather than leaving a
    // blank rectangle where a picture used to be.
    frame.addEventListener('error', function () {
      if (box.parentNode) { box.parentNode.replaceChild(a, box); }
      a.dataset.apLive = '';
    });

    box.appendChild(ratio);
    box.appendChild(frame);
    if (a.parentNode) { a.parentNode.replaceChild(box, a); }
  }

  // Run fn once the page has loaded and the browser is idle, never before. An
  // embed costs a cross-origin connection and ~1 MB of YouTube's code; starting
  // that during the initial load made it the slowest thing on the page (measured
  // 387 ms for the embed vs 3.6 ms to serve the page) for a video nobody had
  // asked to watch. The player only needs to be ready by the time someone
  // reaches it, not in the first frame.
  function whenIdle(fn) {
    if (document.readyState !== 'complete') {
      window.addEventListener('load', function () { whenIdle(fn); }, { once: true });
      return;
    }
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(fn, { timeout: 2000 });
    } else {
      setTimeout(fn, 300);
    }
  }

  function start() {
    // Offline the embed cannot load, and the still with its link is exactly
    // the right thing to show. This is the whole condition for doing anything.
    if (navigator.onLine === false) { return; }

    var cards = [].slice.call(document.querySelectorAll('a.ap-video'));
    if (!cards.length) { return; }

    // The pointer arriving is a deliberate act, so it is honoured immediately.
    // Being on screen is not, so it waits for the page to be done.
    cards.forEach(function (c) {
      c.addEventListener('pointerenter', function () { upgrade(c); });
    });

    if (typeof IntersectionObserver !== 'function') {
      whenIdle(function () { cards.forEach(upgrade); });
      return;
    }
    whenIdle(function () {
      // Start a good screenful early. Loading hidden underneath the still, the
      // player is ready by the time the reader scrolls to it and the fade-in
      // has already happened, so it is just there - no waiting on a blank
      // frame. 600px is roughly one viewport of lead.
      var seen = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { seen.unobserve(e.target); upgrade(e.target); }
        });
      }, { rootMargin: '600px' });
      cards.forEach(function (c) { seen.observe(c); });
    });
  }

  // A reader who was offline and comes back should get the players too.
  window.addEventListener('online', start);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

