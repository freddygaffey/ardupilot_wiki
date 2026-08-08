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

  document.addEventListener('click', function (event) {
    var target = event.target.closest ? event.target.closest('#' + INSTALL_BUTTON_ID) : null;
    if (!target) {
      return;
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

    target.disabled = true;
    ready.then(function () {
      target.disabled = false;
      if (!deferredPrompt) {
        // It never arrived, so this browser will not install it after all.
        remember(false);
        hideInstallButton();
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
