.. _wiki-offline-copies:

=======================
How Offline Copies Work
=======================

.. tip::

   To download a wiki, go to the :ref:`common-offline` page. This page explains
   how that works rather than providing the controls for it.

The wiki can be read with no internet connection, and is noticeably faster to
browse even when you have one. This page explains what the feature does, how to
get the most out of it, and how it is built.

A saved copy does not go stale. Once a wiki has been downloaded it is checked
against the server periodically, and anything that has changed since is fetched
on its own rather than by downloading the wiki again.

Features
========

Three distinct things are provided here. They do different jobs, and which one
you want depends on what you are trying to achieve.

**Faster browsing.** Every page you visit is stored on your device and served
from there the next time it is requested. There is nothing to configure and no
decision to make, and it begins working from your second visit onwards. This
applies to ordinary browsing over a normal internet connection, and most
readers will notice it more than they notice the offline support.

**Saving a wiki for offline use.** Saving downloads the wiki you select
together with the shared image set that all of the wikis draw on. The shared images are needed whichever wiki you
choose and are the larger part of the download: roughly 440 MB of images, plus
about 80 MB for Copter. Once the download has finished, every page in that wiki
opens with no connection at all.

Saving is a deliberate choice rather than something that happens automatically.
The reason is not the size of the download, which is unremarkable for anyone
who has cloned the firmware repository or installed a toolchain. It is that
somebody reading a single page should not have several hundred megabytes arrive
uninvited. If you work from the documentation regularly you will probably want
to save it, because a saved wiki is also the fastest way to read it.

**Exporting the wiki as a single file.** The export produces one ``.html`` file
containing the pages, the images and a full text search index. Open it by
double clicking it: there is nothing to install and it will run from a USB
stick. This is intended for machines you cannot install software on, or for
giving the documentation to somebody on a memory card.

The file is built in your browser out of the wiki already saved on your device,
rather than being downloaded from the server as a file in its own right. That
has a consequence worth knowing before you start: exporting a wiki you have not
saved will download it first, so you end up with a saved copy as well as the
file. Nothing is wasted by this, and an export of a wiki you have already saved
needs no connection at all.

Getting the Most Out of It
==========================

Save the wiki for the vehicle you actually work on. The shared images make up
most of the download and are required regardless, so the first save is the
large one. A second wiki after that costs only its own pages, which is tens of
megabytes rather than hundreds.

Saving needs an internet connection, so save the wiki before you need it rather
than when you arrive.

Installing the site as an app downloads nothing by itself. What it does is make
the browser much less likely to reclaim your saved data when the device runs
short of space, which is worth doing if you are relying on several hundred
megabytes of stored pages.

.. note::

   A saved wiki checks itself against the server while a wiki page is open and
   fetches anything that has changed, so a copy left alone stays current
   without being asked. The check can be turned off, and can be run on demand,
   on the :ref:`common-offline` page.

.. warning::

   A saved wiki lives in your browser's storage for this site. Clearing site
   data removes it, and you will need to download it again.

Speed
=====

The wiki gets faster the more of it you have already read, because pages and
the assets they share are stored on the device as you go. None of this requires
saving a wiki, and it happens on its own.

The table below compares the same page as the wiki behaved before this feature
existed, on a first visit with it, and on every visit afterwards.

+----------------------------------+----------------+----------------+----------------+--------------+
|                                  | Before         | After                           | Difference   |
+                                  +                +----------------+----------------+              +
|                                  |                | New page       | Read again     |              |
+==================================+================+================+================+==============+
| Time to get the page             | about 1,000 ms | about 1,000 ms | 13 to 19 ms    | 60x faster   |
+----------------------------------+----------------+----------------+----------------+--------------+
| Bytes fetched                    | about 156 KB   | about 156 KB   | about 25 KB    | 6x less      |
+----------------------------------+----------------+----------------+----------------+--------------+
| Requests made                    | 21 to 26       | 21 to 26       | about 1        | 26x fewer    |
+----------------------------------+----------------+----------------+----------------+--------------+
| Parameter list (6.1 MB)          | about 8,300 ms | about 8,300 ms | about 2,300 ms | 3.5x faster  |
+----------------------------------+----------------+----------------+----------------+--------------+

The table assumes you have opened some page of the wiki before, which is the
situation almost every reader is in. The service worker and the script that
registers it come to 46 KB, fetched once on the first page you ever open and
never again; charging that to every new page would describe a first-ever visit
rather than an ordinary one. Excluded, a page you have not read costs exactly
what it cost before the feature existed. It is free until it starts paying,
which it does the second time you open anything.

The request row says "about one" rather than none because a stored page is
returned immediately and the worker then asks the server whether it has
changed. You wait for nothing, but the request is real and the server sees it.

The parameter list is the one page where the saving is not mostly about the
network. It is 6.1 MB and contains roughly 210,000 elements, and the browser
spends about six of its eight seconds laying the page out rather than fetching
it. The ``content-visibility`` rule these pages carry reduces that work by
about a factor of three, which is where most of the improvement comes from. It
remains a two second page, and caching will not change that, because the cost
is the size of the document itself.

The reduction in bytes is worth explaining. Of the resources a page pulls in,
twelve are shared assets totalling 131 KB and are identical on every page of
the wiki, so they are fetched only once. After that a page costs its own HTML
and its own images and nothing else, which is why the wiki gets faster as you
read rather than staying the same.

With no connection at all, pages you have already visited still open, and a
saved wiki opens completely.

Implementation
==============

Everything below this point describes how the feature is built, and is aimed at
anyone changing it or reviewing changes to it. It is not needed in order to use
the wiki offline.

.. figure:: ../images/wiki-offline-request-flow.svg
    :target: ../_images/wiki-offline-request-flow.svg
    :width: 100%

    How the service worker answers a request for a page.

The Service Worker
------------------

A service worker is a script the browser runs in the background, independently
of any page and persisting after the page that registered it closes. Once
active it sits between the pages in its scope and the network: every request
those pages make is passed to it, and it answers either from local storage or
by forwarding the request onward.

That interception is the whole mechanism. The pages are unmodified static HTML
as built by Sphinx; nothing is rewritten and no framework is introduced.

Implementation is in ``frontend/sw.js``, registered by ``frontend/js/pwa.js``,
which ``common/_templates/layout.html`` includes on every page.

.. note::

   Service workers require a secure context: ``https://``, or
   ``http://localhost`` for development. A wiki served over plain HTTP has no
   offline support at all.

Storage
-------

Cache Storage holds complete HTTP responses keyed by request URL, in named
stores. It is separate from the browser's HTTP cache, is not cleared with
browsing history, and is scoped to the origin.

``ardupilot-pages-v3``, ``-images-v3``, ``-static-v3``
   Populated while browsing. Discarded when ``CACHE_VERSION`` changes.

``ardupilot-offline-<wiki>``
   A saved wiki. Excluded from version-bump deletion, since it holds content
   the reader chose to store.

``ardupilot-thirdparty-v3``
   Cross-origin assets, so they are not re-fetched on every page.

``heldOffline()`` in ``sw.js`` decides whether a URL is held. It serves every
resource type, and tries each form a URL may have been stored under, including
the ``/_common/`` path used for images shared between wikis.

.. note::

   Stored keys are the URLs the site serves. ArduPilot serves
   ``/copter/docs/foo.html`` directly. A host that canonicalises URLs, by
   stripping ``.html`` for instance, breaks offline reading while leaving
   online browsing unaffected, which makes it a difficult fault to attribute.

Why Browsing Is Fast
--------------------

Four things account for most of it.

Content held locally is preferred over the network. A page that is stored is
returned immediately and revalidated in the background, and if the copy that
comes back differs, the page is told and offers you a reload.

Lookups are directed rather than exhaustive. Calling ``caches.match()`` without
naming a store searches every store in turn, and a reader who has saved every
wiki has fourteen of them. Since the URL identifies the single store that could
hold it, the worker looks only there, which takes 89 ms against 692 ms for the
same request. The exhaustive search is kept as a fallback.

Content found in a saved wiki is copied into the runtime store the first time
it is used, so later requests for it resolve directly. This takes 1 ms against
84 ms.

Assets carrying a fingerprint are served from storage without checking the
network. Sphinx stamps them, as in ``theme.css?v=5d32c60e``, so a stored copy
can only be the copy that the fingerprint names.

That last point is also why the wiki costs the server less to serve. Of the 21
to 26 resources a page pulls in, twelve are shared assets totalling 131 KB and
are byte-identical on every page. Once they are held they are never requested
again, so the second page and every page after it costs its own HTML plus its
own images: a median of 25 KB against about 156 KB. This applies to every
reader from their second page onwards, whether or not they ever save a wiki.

Prefetching
-----------

``pwa.js`` fetches a page shortly before it is likely to be wanted, judging
from the pointer's position, its velocity projected forward, and whether it is
slowing down as it approaches a link. A pointer crossing a link at speed
triggers nothing.

Speculative traffic is deliberately bounded. At most eight pages are fetched
per page view, at least 400 ms apart, with only one request in flight at a
time and each URL fetched at most once. Anything larger than 2 MB is abandoned,
and requests still in flight are cancelled when you navigate. Pages that are
already stored bypass the budget entirely and generate no traffic at all.

.. note::

   Nothing is fetched speculatively if you have asked your browser to reduce
   data usage, or on pages carrying more than 250 links. On those pages the
   links are an index rather than a sign of where you intend to go.

Saving a Wiki
-------------

Fetching the pages one at a time would be roughly 3,400 requests per reader for
Copter alone. Each wiki is packed into an archive at build time instead, and
unpacked by the browser.

``common_offline_page.js`` streams the archive and unpacks each entry as it
arrives rather than buffering the whole file first. Every entry is written to
Cache Storage under the URL the site serves it at, so saved content is
retrieved by exactly the same path as content that was stored while browsing.

Two constraints apply:

* The archives are served with a content coding, so the browser decompresses
  them before the script sees the body. This avoids relying on
  ``DecompressionStream``, which is missing from Safari before 16.4 and Firefox
  before 113.
* A completion marker is written last, and a saved wiki only counts as usable
  once that marker exists, so an interrupted download is never mistaken for a
  complete one.

Building and Serving
====================

.. figure:: ../images/wiki-offline-build-and-deploy.svg
    :target: ../_images/wiki-offline-build-and-deploy.svg
    :width: 100%

    How the archives are built and served.

``scripts/build_offline_artifacts.py`` runs during a build when ``--offline``
is passed, writing into ``<destdir>/offline/``:

``offline-manifest.json``
   Sizes, page counts and a build id. The download page renders from this
   rather than hardcoding figures.

``common-offline.tar.gz``
   Images used by two or more wikis. The majority of the total size, kept
   separate because including them per wiki would multiply several hundred
   megabytes across eleven.

``<wiki>-offline.tar.gz``
   Content unique to a single wiki.

Archives are reproducible: tar metadata is normalised, so unchanged content
produces byte-identical output and a deploy can skip it.

Requirements
------------

The archives are static files, and no application server or database is
involved. The host must meet four requirements:

- Pages must be served at their built URLs. ``/copter/docs/foo.html`` must
  return that page rather than redirecting to ``/copter/docs/foo``.
- The worker must not be cached. ``/sw.js`` must be served with
  ``Cache-Control: no-cache``.
- Archives must be paired with their compressed form. Under nginx,
  ``gzip_static on`` in the ``/offline/`` location serves ``<name>.tar.gz`` in
  place of ``<name>.tar`` and sets the content coding.
- The frontend must be served from the web root. A service worker's scope is
  its own path and everything below it, so a worker placed at
  ``/frontend/sw.js`` registers successfully and then controls no wiki page at
  all.

``deploy/nginx-wiki.conf`` is a working configuration.

Recovery
--------

This is a worst case, and is described because it is the one failure a reader
cannot clear themselves.

A service worker outlives the page that registered it and controls every page
in its scope, so a faulty one is not resolved by reloading, by navigating
elsewhere on the site, or usually by restarting the browser. A worker serving
wrong or stale content will keep doing so.

``frontend/sw-kill.js`` exists for that case. Deployed in place of ``sw.js``,
it unregisters the worker and deletes its caches on every device that fetches
it, returning readers to an ordinary website. It is a one-line deploy and asks
nothing of readers.

This works only if the browser will collect the replacement, which is why
``/sw.js`` must be served ``no-cache``. That header is not a nicety: without
it there is no remote means of recovery.

Testing
-------

.. code-block:: bash

    npm install --no-save jsdom
    npm test

``scripts/tests/test_offline_worker.js``
   Builds a cache from real archives, requests the URLs the site serves, and
   resolves them with the worker's own code.

``scripts/tests/test_offline_page.js``
   Drives the download panel under jsdom, including the update check.

``scripts/tests/test_offline_export.js``
   Runs the exporter against build output and inspects the result.

``scripts/tests/test_offline_archives.py``
   Inspects the finished archives. Requires ``update.py --offline`` first.

Tests exercise the shipped code rather than a reimplementation of it, and each
must be shown to fail when the behaviour it covers is removed.

Limitations
===========

* The shared image set is required whichever wiki is chosen, so the first save
  is about 440 MB before anything is readable offline, whichever wiki that is.
* The generated reference pages, such as the full parameter lists and the board
  feature tables, reach several megabytes and hundreds of thousands of
  elements. Their cost is in rendering rather than transfer, so caching does
  not help them.
* EPUB and PDF output are not covered by this feature.
* A saved copy is only checked for updates while a wiki page is open in the
  browser. Nothing runs in the background once every tab is closed.
