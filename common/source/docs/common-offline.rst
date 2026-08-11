:orphan:

.. Reached from the top menu rather than a toctree, so mark it orphan and keep
.. the build warning-free.

.. _common-offline:

==============
Offline Copies
==============

Keep the documentation readable with no connection: in a hangar, in a field, or
anywhere the signal runs out.

Two separate things live on this page, and they are easily confused. *Saving
pages* makes the wiki readable offline and works in an ordinary browser tab.
*Installing* the app downloads nothing at all. It only gives the wiki its own
window, and makes your browser less likely to delete what you have saved.

Everything here is served from this site. A saved wiki arrives as one ordinary
file download, and your browser unpacks it locally: nothing is sent anywhere,
and no account is needed at any point.

For how any of this works, what it needs to run and how to test it, see `How
Offline Copies Work <../../dev/docs/wiki-offline-copies.html>`__ in the
developer documentation.

.. raw:: html

   <!-- The tool. Markup only:

          styling    _static/common_offline.css, copied into every wiki by
                     copy_common_source_files() from common/source/_static,
                     the same route common_theme_override.css takes. That is
                     what puts it inside each wiki's archive; it previously
                     lived in frontend/, outside the Sphinx build, so it
                     reached no archive and the panel was unstyled offline.
          behaviour  _static/common_offline_page.js      (the panel)
                     _static/common_offline_export.js    (reading the cache)
                     _static/common_offline_document.js  (what the .html says)

                     Static assets for the same reason the stylesheet is: they
                     travel inside each wiki's archive, so the panel works
                     offline without the service worker having to know they
                     exist.

        Self-contained - every tag opened here is closed here. A <div> opened
        in one raw block and closed in another lands inside different section
        wrappers, which corrupts the nesting and pushes the page footer out of
        the content column.

        Follows ArduPilot's other tool front-end, custom.ardupilot.org: dark
        header strip, status badges, progress bars. -->


   <div id="storage-warning"></div>

   <div class="apo">

     <div class="apo-head">
       <p class="apo-title">Offline storage</p>
       <span class="apo-spacer"></span>
       <button id="download-cache-btn" class="apo-btn apo-btn-primary">Save selected</button>
       <button id="check-btn" class="apo-btn apo-btn-ghost">Check for updates</button>
       <button id="clear-btn" class="apo-btn apo-btn-danger">Remove all</button>
     </div>

     <table class="apo-table">
       <thead>
         <tr>
           <th class="apo-name"><span class="apo-pick"><input type="checkbox"
                 id="select-all" title="Select every wiki"
                 aria-label="Select every wiki" /><span>Wiki</span></span></th>
           <th class="apo-num">Size</th>
           <th class="apo-num apo-pages-h">Pages</th>
           <th class="apo-num">Progress</th>
           <th class="apo-num">Status</th>
         </tr>
       </thead>
       <tbody id="wiki-rows"></tbody>
     </table>

     <div class="apo-foot">
       <label><input type="checkbox" id="autoupdate" checked="checked" />
         <span>Update saved pages automatically</span></label>
       <div class="apo-status apo-foot-status">
         <span id="selection-total"></span>
         <span id="cache-progress" hidden="hidden"></span>
         <span id="check-result" hidden="hidden"></span>
       </div>
       <div class="apo-status apo-foot-status">
         <span id="storage-status"></span>
         <span id="build-date"></span>
       </div>
     </div>

     <div class="apo-files">
       <h3>Save a copy as a file</h3>
       <p class="apo-hint" style="margin-top:0">Built on this device from the
         wikis ticked above. Anything not saved yet is downloaded first, so
         one press is enough. Each file contains exactly the wikis you chose,
         shared images included.</p>

       <div class="apo-file">
         <button id="dl-single" class="apo-btn apo-btn-outline">Save as .html</button>
         <div class="apo-hint">A single self-contained page. Double-click it, nothing
           to install. Search works across the full text of every page. It runs
           from a USB stick, though it is large and takes a moment to open.</div>
       </div>
     </div>

   </div>

What to Expect
==============

**Saving a wiki makes every page in it open instantly, whether or not you have
a connection.** Pages come from your own device rather than the network, so
browsing stays fast in a hangar, on a plane, or on a site with no signal.

It costs storage. Roughly:

===============================  ==========
Shared images (required)         about 440 MB
A vehicle wiki on top of that    3 to 75 MB
All eleven wikis                 about 700 MB
===============================  ==========

The shared images are needed whichever wiki you choose, because nearly every
page uses them, so the first save is the large one. Saving a second wiki
afterwards costs only its own pages.

.. note::

   Saved pages live in your browser's storage for this site. Clearing site data
   removes them, and you would need to download again.

How It Works
============

The wiki is stored by your browser and served from your own device, using a
mechanism browsers provide for exactly this. Nothing is sent anywhere, no
account is involved, and the pages you read offline are the same files the site
serves normally.

Install as an App
=================

.. note::

   Installing downloads nothing, and is not needed to read offline. Saving pages
   works in an ordinary browser tab. It gives the wiki its own window and a
   launcher icon, and makes your browser less likely to delete your saved
   pages when the device runs low on space.

.. raw:: html

   <div class="apo-install-row">
     <button id="ap-install-app" class="apo-btn apo-btn-outline" hidden="hidden">Install app</button>
     <span id="install-state" class="apo-hint"></span>
   </div>

   <script src="../_static/common_offline_document.js" defer="defer"></script>
   <script src="../_static/common_offline_export.js" defer="defer"></script>
   <script src="../_static/common_offline_page.js" defer="defer"></script>

[copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
