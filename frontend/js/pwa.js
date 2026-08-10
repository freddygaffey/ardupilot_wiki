/*
 * PWA glue for the ArduPilot wiki: registers the service worker, drives an
 * explicit install button, and surfaces page updates.
 *
 * The install prompt is never left to the browser's own banner. We capture the
 * event, suppress the banner, and only offer installation when the reader
 * clicks our button.
 *
 * Loaded from the wiki theme (common/_templates/layout.html) and from the
 * frontend pages, so it must cope with the button being absent.
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
    if (event.data.type === 'PAGE_UPDATED' && event.data.url === window.location.href) {
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

  // Registered here rather than inside the load handler: the service worker is
  // part of what the browser checks before deciding the site is installable,
  // so waiting for load delays beforeinstallprompt for no reason.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerServiceWorker);
  } else {
    registerServiceWorker();
  }

  function registerServiceWorker() {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (registration) {
      // Browsers already re-check sw.js on navigation; this makes the check
      // explicit so a fixed worker - or the kill switch in sw-kill.js - reaches
      // installed clients on their next visit rather than eventually. It is one
      // conditional request, normally answered with a 304.
      registration.update();
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
 * TODO(mirror): delete this when served from ardupilot.org.
 *
 * The wiki links to itself by absolute URL in a few hundred places, and the
 * theme's own menu adds about ten more to every page. On ardupilot.org those
 * are same-origin and resolve without help. On a mirror they walk the reader
 * off the site, and offline they fail outright: the document is gone and what
 * replaces it is a browser error.
 *
 * A service worker CANNOT catch this. A top-level navigation to another origin
 * is never handed to one, so no fetch event fires and there is nothing to
 * intercept. Anything built there would look right in testing and fail on the
 * first real click.
 *
 * So catch it at click time, which is the only place it can be caught. Only
 * links to a wiki this site actually serves are rewritten: /discord, /donate,
 * the firmware server and the forum are separate services with no local copy,
 * and they are left to leave normally.
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
 * Fetch a page when the reader looks like they are about to open it.
 *
 * A hover, or a touch starting, is roughly 100-300ms of warning before the
 * click. That is enough to have the page in cache by the time the navigation
 * begins, which is the difference between a wiki that feels quick and one that
 * feels instant.
 *
 * Deliberately modest: same-origin wiki pages only, one in flight at a time,
 * each URL at most once, and nothing at all when the reader has asked to save
 * data or is on a connection where speculative traffic would be rude.
 */
(function () {
  'use strict';

  var conn = navigator.connection || {};
  if (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '')) {
    return;
  }

  var asked = new Set();
  var inFlight = 0;
  var timer = null;

  function worthPrefetching(a) {
    if (!a || !a.href || a.target === '_blank') { return null; }
    var u;
    try { u = new URL(a.href); } catch (e) { return null; }
    if (u.origin !== location.origin) { return null; }
    if (u.pathname === location.pathname) { return null; }
    if (!/\.html?$|\/$/.test(u.pathname)) { return null; }
    u.hash = '';
    if (asked.has(u.href)) { return null; }
    return u.href;
  }

  function prefetch(href) {
    if (inFlight >= 1) { return; }
    asked.add(href);
    inFlight++;
    // Low priority so it can never compete with what the reader asked for.
    fetch(href, { credentials: 'same-origin', priority: 'low' })
      .catch(function () { /* a speculative miss costs nothing */ })
      .then(function () { inFlight--; });
  }

  document.addEventListener('mouseover', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    var href = worthPrefetching(a);
    if (!href) { return; }
    clearTimeout(timer);
    // A pointer crossing a link on its way elsewhere is not intent.
    timer = setTimeout(function () { prefetch(href); }, 120);
  }, { passive: true });

  document.addEventListener('mouseout', function () { clearTimeout(timer); },
                            { passive: true });

  // Touch has no hover, so the touch itself is the signal.
  document.addEventListener('touchstart', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    var href = worthPrefetching(a);
    if (href) { prefetch(href); }
  }, { passive: true });
})();
