:orphan:

.. Reached from the top menu rather than a toctree, so mark it orphan and keep
.. the build warning-free.

.. _common-offline:

==============
Offline Copies
==============

.. raw:: html

   <!-- One self-contained raw block: the theme supplies the page title,
        breadcrumbs, sidebar, top menu and fonts; this is only the body.
        A div opened in one raw block and closed in another straddles the
        section wrappers docutils generates and corrupts the nesting, so this
        stays a single block.
        Scoped under .apo throughout - no bare element selectors - so it cannot
        restyle anything else on the page.
        Driven by /js/offline-page.js, loaded at the end. -->
   <style>
     .apo { --blue:#2980b9; --ink:#404040; --dim:#757575; --rule:#e1e4e5;
            --soft:#f3f6f6; --panel:#fff; }
     .apo h2 { font-size:1.25rem; font-weight:700; margin:32px 0 10px;
               padding-bottom:6px; border-bottom:1px solid var(--rule); }
     .apo h2:first-of-type { margin-top:18px; }

     .apo .kv { display:flex; align-items:baseline; gap:10px; margin:0 0 6px; }
     .apo .kv .k { color:var(--dim); white-space:nowrap; }
     .apo .kv .lead2 { flex:1; border-bottom:1px dotted var(--rule);
                       transform:translateY(-4px); }
     .apo .kv .v { white-space:nowrap; font-weight:700;
                   font-variant-numeric:tabular-nums; }

     .apo table.apo-table { width:100%; border-collapse:collapse;
                            border:1px solid var(--rule); background:var(--panel);
                            margin:14px 0 10px; }
     .apo table.apo-table td { padding:9px 14px; border:0;
                               border-bottom:1px solid var(--rule);
                               vertical-align:middle; }
     .apo table.apo-table tr:last-child td { border-bottom:0; }
     .apo table.apo-table tr:nth-child(2n) td { background:var(--soft); }
     .apo table.apo-table tr:hover td { background:#e7f2fa; }
     .apo td.num { text-align:right; white-space:nowrap; color:var(--dim);
                   font-variant-numeric:tabular-nums; width:1%; }
     .apo td.name { width:auto; }
     .apo label { cursor:pointer; display:inline-flex; align-items:center;
                  gap:10px; margin:0; font-weight:400; }
     .apo input[type=checkbox] { accent-color:var(--blue); width:15px;
                                 height:15px; margin:0; flex:none; }
     .apo select { padding:6px 10px; border:1px solid #ccc; background:#fff; }

     .apo .pill { color:var(--dim); }
     .apo .pill.stored { color:#1abc9c; font-weight:700; }
     .apo .pill.stored::before { content:"\2713 "; }
     .apo .total { font-weight:700; margin:0 0 6px; }

     .apo .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center;
                     margin:14px 0; }
     .apo .actions .btn { margin:0; }

     .apo .warn { background:#ffedcc; border-left:4px solid #f0b37e;
                  padding:12px 16px; margin:14px 0; }
     .apo .ok { background:#dbfaf4; border-left:4px solid #1abc9c;
                padding:12px 16px; margin:14px 0; }
     .apo .note-box { background:#e7f2fa; border-left:4px solid #6ab0de;
                      padding:12px 16px; margin:14px 0; }

     .apo .dl { margin-bottom:20px; }
     .apo #archive-links a { display:block; font-weight:700; }
     .apo .hint { color:var(--dim); font-size:90%; margin-top:3px; }
   </style>

   <div class="apo">

     <p>Keep the documentation readable with no connection &mdash; in a hangar, in
        a field, or anywhere the signal runs out.</p>

     <p>Two separate things live on this page, and they are easily confused.
        <em>Saving pages</em> makes the wiki readable offline and works in an
        ordinary browser tab. <em>Installing</em> the app downloads nothing at all
        &mdash; it only gives the wiki its own window, and makes your browser far
        less likely to delete what you have saved.</p>

     <h2>On this device</h2>

     <div id="storage-status"></div>
     <div class="kv"><span class="k">Build</span><span class="lead2"></span>
       <span class="v" id="build-date">&mdash;</span></div>
     <div id="storage-warning"></div>

     <h2>Choose what to keep</h2>

     <p>Common holds the images and pages shared between every wiki. It is
        required, and is downloaded only once however many vehicles you pick
        &mdash; which is why keeping three vehicles costs far less than three
        times one.</p>

     <table class="apo-table"><tbody id="wiki-rows"></tbody></table>
     <p class="total" id="selection-total"></p>

     <div class="actions">
       <button id="download-cache-btn" class="btn">Save in browser</button>
       <button id="check-btn" class="btn btn-neutral">Check for updates</button>
       <button id="persist-btn" class="btn btn-neutral" hidden>Make storage permanent</button>
       <button id="clear-btn" class="btn btn-neutral">Remove all</button>
       <span id="cache-progress" class="pill" hidden></span>
       <span id="check-result" class="pill" hidden></span>
     </div>
     <p><label><input type="checkbox" id="autoupdate" checked>
       <span>Update saved pages automatically</span></label></p>

     <h2>Download a copy</h2>

     <div class="dl">
       <div id="archive-links"></div>
       <div class="hint">Unpack and open <code class="docutils literal">index.html</code>.
         Pages load instantly; search needs to be served rather than opened
         straight from disk.</div>
     </div>

     <div class="dl">
       <a id="dl-pyz" href="#">Build wiki.pyz from saved pages</a>
       <div class="hint">Built here from the pages you have saved, so nothing extra is downloaded.
         <code class="docutils literal">python3 wiki.pyz</code> serves it locally
         &mdash; instant pages, working search, nothing extracted to disk.</div>
     </div>

     <div class="dl">
       <a id="dl-single" href="#">Build a single HTML file from saved pages</a>
       <div class="hint">Double-click, nothing to install. Around 30 seconds to
         open and several hundred megabytes, but Ctrl+F searches every page at
         once and it works from a USB stick.</div>
     </div>

     <h2>Install as an app</h2>

     <div class="note-box">
       <strong>Installing downloads nothing</strong>, and is not needed to read
       offline &mdash; saving pages works in an ordinary browser tab. It gives the
       wiki its own window and a launcher icon, and makes your browser far less
       likely to delete your saved pages when the device runs low on space.
     </div>

     <div class="actions">
       <button id="ap-install-app" class="btn" hidden>Install app</button>
       <span id="install-state" class="hint"></span>
     </div>

   </div>

   <script src="/js/offline-export.js" defer></script>
   <script src="/js/offline-page.js" defer></script>

[copywiki destination="copter,plane,rover,sub,blimp,antennatracker,dev,planner,planner2,ardupilot,mavproxy"]
