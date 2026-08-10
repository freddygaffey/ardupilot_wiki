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
 * Builds downloadable copies from what is already in Cache Storage.
 *
 * The alternative was for the build server to produce and host a ~970MB file
 * for every combination of wikis, duplicating content the reader has already
 * downloaded. Generating it here means the server hosts only the archives,
 * and the export costs nothing extra to fetch.
 *
 * Everything streams. A few hundred megabytes cannot be assembled in a Blob or
 * a string, so the page writes chunks into a stream that the service worker
 * answers as a download response, and the browser writes it to disk as it goes.
 * Peak memory is one file, not one archive.
 */
(function (global) {
  'use strict';

  var OFFLINE_CACHE_PREFIX = 'ardupilot-offline-';
  var COMPLETE_MARKER = '/__ap_complete__';

  /* --------------------------------------------------------- cache reading */

  /** Every cached entry belonging to a stored wiki, as [path, Response]. */
  function storedEntries(wikiIds) {
    return caches.keys().then(function (names) {
      var wanted = names.filter(function (n) {
        if (n.indexOf(OFFLINE_CACHE_PREFIX) !== 0) { return false; }
        var id = n.slice(OFFLINE_CACHE_PREFIX.length);
        return wikiIds.indexOf(id) !== -1 || id === 'common';
      });
      return Promise.all(wanted.map(function (name) {
        return caches.open(name).then(function (cache) {
          return cache.keys().then(function (reqs) {
            return { cache: cache, reqs: reqs };
          });
        });
      }));
    });
  }

  /* ------------------------------------------------------ download plumbing */

  /**
   * Open a download the page can write into.
   *
   * Prefers the service worker: it can answer with a ReadableStream, so the
   * browser writes to disk while we are still generating, and this works
   * outside Chromium. Falls back to the File System Access API, and finally to
   * a Blob for browsers with neither - which is memory-bound, so it is only a
   * last resort.
   */
  function openDownload(filename) {
    // Order matters, and none of these may be assumed available. A page can be
    // uncontrolled for perfectly ordinary reasons - a hard reload, a first
    // visit before the worker activates, a worker that failed to install - so
    // the export has to work regardless rather than depend on one path.
    if (navigator.serviceWorker && navigator.serviceWorker.controller &&
        typeof TransformStream !== 'undefined') {
      var ts = new TransformStream();
      var writer = ts.writable.getWriter();
      var id = String(Date.now()) + Math.random().toString(36).slice(2);

      navigator.serviceWorker.controller.postMessage(
        { type: 'EXPORT_START', id: id, filename: filename, stream: ts.readable },
        [ts.readable]
      );

      // An iframe rather than location: navigating away would tear down the
      // page that is generating the stream.
      var frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = '/__export__/' + id;
      document.body.appendChild(frame);

      return Promise.resolve({
        write: function (chunk) { return writer.write(chunk); },
        close: function () {
          return writer.close().then(function () {
            setTimeout(function () { frame.remove(); }, 2000);
          });
        }
      });
    }

    // Needs a user gesture, which the click that got us here provides.
    if (global.showSaveFilePicker) {
      return global.showSaveFilePicker({ suggestedName: filename })
        .then(function (handle) { return handle.createWritable(); })
        .then(function (w) {
          return {
            write: function (chunk) { return w.write(chunk); },
            close: function () { return w.close(); }
          };
        });
    }

    var parts = [];
    return Promise.resolve({
      write: function (chunk) { parts.push(chunk); return Promise.resolve(); },
      close: function () {
        var url = URL.createObjectURL(new Blob(parts));
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        return Promise.resolve();
      }
    });
  }

  /* --------------------------------------------------- exports: single HTML */

  var BINARY = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i;

  function mimeFor(path) {
    var ext = (path.split('.').pop() || '').toLowerCase();
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
              ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
              ttf: 'font/ttf' })[ext] || 'application/octet-stream';
  }

  function base64(bytes) {
    // Chunked: String.fromCharCode.apply blows the argument limit on anything
    // more than a few tens of kilobytes, and these are photographs.
    var out = '', CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(out);
  }

  function anchorFor(path) {
    return 'ap-' + path.replace(/^\//, '').replace(/\.[^.]*$/, '')
                       .replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  }

  // The shell: a single-page app, not a concatenation.
  //
  // Pages are written as inert <script type="text/plain"> blocks. The browser
  // parses them as text but never renders them or decodes the data URIs inside,
  // so opening the file costs one parse rather than laying out hundreds of
  // pages and decoding several hundred megabytes of images at once. A page is
  // materialised only when you navigate to it.
  // Only what the app itself needs. Everything else - type, headings,
  // admonitions, code blocks, tables - comes from the theme's own stylesheet,
  // embedded at export time, so this looks like the site rather than like an
  // approximation of it.
  var SHELL_CSS =
    'html,body{height:100%}' +
    '.wy-nav-side{overflow-y:auto}' +
    '#ap-search{margin:12px;padding:8px 10px;border:0;border-radius:3px;' +
    'font:inherit;width:calc(100% - 24px)}' +
    '#ap-nav a.on{background:#2e2b2b;border-left:3px solid #2980b9;color:#fff;' +
    'font-weight:700}' +
    '#ap-miss{display:none;padding:10px 16px;color:#a8620f;background:#ffedcc;' +
    'font-size:13px}' +
    '#ap-bar{background:#2980b9;color:#fff;padding:8px 16px;font-size:13px}' +
    '#ap-brand{background:#2980b9;color:#fff;padding:14px 16px;font-weight:700}' +
    '#ap-brand small{display:block;font-weight:400;opacity:.85;font-size:12px}' +
    '#ap-crumb{padding:6px 0;color:#666;font-size:13px;text-transform:uppercase;' +
    'letter-spacing:.05em}' +
    '#ap-lightbox{position:fixed;top:0;right:0;bottom:0;left:0;z-index:9999;' +
    'display:none;align-items:center;justify-content:center;cursor:zoom-out;' +
    'background:rgba(0,0,0,.85)}' +
    '#ap-lightbox img{max-width:94vw;max-height:94vh}' +
    '#ap-pick{list-style:none;margin:1em 0 0;padding:0}' +
    '#ap-pick li{border-bottom:1px solid #e1e4e5}' +
    '#ap-pick a{display:flex;align-items:baseline;justify-content:space-between;' +
    'gap:1em;padding:12px 2px;text-decoration:none}' +
    '#ap-pick small{color:#666;text-transform:none;font-size:.85em}' +
    '.ap-results li{padding:10px 0}' +
    '.ap-results a{padding:0;border:0}' +
    '.ap-snip{margin:.25em 0 0;color:#4a4a4a;font-size:.9em;line-height:1.5}' +
    '.ap-snip mark{background:#fff3b0;color:inherit;padding:0 2px}' +
    '.ap-actions{display:flex;flex-wrap:wrap;gap:0 1.5em}' +
    '#ap-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
    'z-index:10000;display:none;align-items:center;gap:1em;' +
    'max-width:min(680px,92vw);padding:12px 16px;border-radius:4px;' +
    'background:#1f2d3a;color:#fff;font-size:14px;line-height:1.4;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.3)}' +
    '#ap-toast.on{display:flex}' +
    '#ap-toast a{color:#8ecbff;text-decoration:underline;white-space:nowrap}' +
    '#ap-toast button{background:none;border:0;color:#c3ccd5;font:inherit;' +
    'cursor:pointer;padding:0;white-space:nowrap}';

  var SHELL_JS = [
    '(function(){',
    'var D=JSON.parse(document.getElementById("ap-index").textContent);',
    'var doc=document.getElementById("ap-doc");',
    'var nav=document.getElementById("ap-nav");',
    'var crumb=document.getElementById("ap-crumb");',
    'var miss=document.getElementById("ap-miss");',
    'var search=document.getElementById("ap-search");',
    // Anchors are page paths, not ordinals. An ordinal shifts whenever the set
    // of exported pages changes, so a bookmark into last month's file would
    // land somewhere else in this month's.
    'var byPath={};D.pages.forEach(function(p,i){byPath[p.p]=i;});',
    'nav.innerHTML=D.nav;',
    'var links=[].slice.call(nav.querySelectorAll("a[href^=\\"#\\"]"));',
    'function current(){return (location.hash||"").replace(/^#/,"");}',
    // Accept the shorthand people actually type. #/rover should land on the
    // Rover wiki, not on a "page not found" - as should a trailing slash, a
    // leftover .html, or a missing leading slash.
    'function lookup(raw){',
    'if(!raw)return undefined;',
    'var cands=[],p=raw;',
    'if(p.charAt(0)!=="/")p="/"+p;',
    'p=p.replace(/\\.html?$/,"");',
    'cands.push(p);',
    'if(p.slice(-1)==="/")cands.push(p.slice(0,-1));',
    'var base=p.replace(/\\/$/,"");',
    'cands.push(base+"/index");',
    'cands.push(base+"/docs/index");',
    'for(var i=0;i<cands.length;i++){',
    'if(byPath[cands[i]]!==undefined)return cands[i];}',
    // Last resort: the first page under that prefix, so #/rover/docs works.
    'for(var j=0;j<D.pages.length;j++){',
    'if(D.pages[j].p.indexOf(base+"/")===0)return D.pages[j].p;}',
    'return undefined;}',
    // Landing page when the file holds more than one wiki. Picking one of them
    // to open on is a guess, and the reader is the only one who knows.
    'function showPicker(){',
    'miss.style.display="none";',
    'var rows=D.homes.map(function(h){',
    'return \'<li><a href="#\'+h.path+\'"><span>\'+(h.name||h.id)+\'</span>\'',
    '+\'<small>\'+h.pages+\' pages</small></a></li>\';}).join("");',
    'doc.innerHTML="<h1>Offline copy</h1><p>This file contains "+D.homes.length',
    '+" wikis. Choose one to start reading.</p><ul id=\\"ap-pick\\">"+rows+"</ul>";',
    'crumb.textContent="";',
    'document.title="ArduPilot (offline)";',
    'links.forEach(function(a){a.className="";});',
    'var sc=document.querySelector(".wy-nav-content-wrap");if(sc)sc.scrollTop=0;}',

    // A page rather than a banner that vanishes. Landing somewhere that says
    // what happened, and offers a way on, beats a message the reader may not
    // have been looking at when it appeared.
    'function showMissing(raw){',
    'miss.style.display="none";',
    'var held=D.homes.map(function(h){return h.name||h.id;}).join(", ");',
    'var live="https://ardupilot.org"+(raw==="/"?"":raw+".html");',
    'doc.innerHTML="<h1>Not in this offline copy</h1>"',
    '+"<p><code>"+raw+"</code> is not included in this download.</p>"',
    '+"<p>This file contains: "+held+".</p>"',
    '+"<p class=\\"ap-actions\\">"',
    // data-ap-external keeps the click handler off it. Without that the link
    // is an ardupilot.org URL like any other and gets routed straight back
    // here, which is a loop rather than a way out.
    '+"<a href=\\""+live+"\\" data-ap-external=\\"1\\">Open it on ardupilot.org</a>"',
    '+"<a href=\\"#\\" id=\\"ap-back\\">Go back</a>"',
    '+(D.homes.length>1?"<a href=\\"#/\\">Choose a wiki</a>":"")+"</p>"',
    '+"<p><small>Opening the live wiki needs a connection. '
      + 'With none it will simply fail to load, and this file is still here.'
      + '</small></p>";',
    'var b=document.getElementById("ap-back");',
    'if(b)b.addEventListener("click",function(ev){ev.preventDefault();history.back();});',
    'crumb.textContent="";',
    'document.title="Not in this offline copy - ArduPilot";',
    'var sc=document.querySelector(".wy-nav-content-wrap");if(sc)sc.scrollTop=0;}',

    'function show(raw){',
    'var path=lookup(raw);',
    'if(path===undefined){return showMissing(raw);}',
    'var i=byPath[path];',
    'miss.style.display="none";',
    'var el=document.getElementById("p"+i);if(!el)return;',
    'doc.innerHTML=el.textContent;',
// Images are stored once and referenced by id; attach them only
// for the page being shown, so nothing else decodes.
'[].forEach.call(doc.querySelectorAll("[data-ap-img]"),function(im){',
'var b=document.getElementById("i"+im.getAttribute("data-ap-img"));',
'if(b)im.src=b.textContent;});',
    'var sc=document.querySelector(".wy-nav-content-wrap");if(sc)sc.scrollTop=0;',
    // The page's own <h1> follows, so name the wiki rather than repeat it.
    'var wid=D.pages[i].p.split("/")[1]||"";',
    'var wh=null;D.homes.forEach(function(h){if(h.id===wid)wh=h;});',
    'crumb.textContent=wh?wh.name:wid.replace(/^./,function(c){return c.toUpperCase();});',
    'document.title=D.pages[i].t+" - ArduPilot (offline)";',
    'links.forEach(function(a){',
    'var on=a.getAttribute("href")==="#"+path;',
    'a.className=on?"on":"";',
    'if(on&&a.scrollIntoView)a.scrollIntoView({block:"nearest"});});}',
    'function route(){',
    'var raw=current();',
    'if(!raw||raw==="/"){',
    'return D.home?show(D.home):showPicker();}',
    'show(raw);}',
    'window.addEventListener("hashchange",route);',
    // Built once and reused. A browser will not navigate to a data: URL, so
    // linked images are shown here rather than opened.
    'function lightbox(uri){',
    'var lb=document.getElementById("ap-lightbox");',
    'if(!lb){lb=document.createElement("div");lb.id="ap-lightbox";',
    'lb.addEventListener("click",function(){lb.style.display="none";});',
    'document.body.appendChild(lb);}',
    'lb.innerHTML="";',
    'var im=document.createElement("img");im.src=uri;lb.appendChild(im);',
    'lb.style.display="flex";}',
    // An anchor parses the host for us, which beats a regular expression in a
    // file assembled from single-quoted literals: a backslash written here is
    // one the built page never sees.
    'function hostOf(u){var a=document.createElement("a");a.href=u;',
    'return a.hostname||u;}',
    // A link to another host is not in this file and never can be. Following
    // it silently costs the reader the whole document and, with no connection,
    // gives them a browser error in exchange. So say what is about to happen
    // and let them choose. This has to replace the navigation rather than
    // accompany it: a message shown on the way out is one nobody reads, and
    // the page carrying it is already gone.
    'var toastTimer=null;',
    'function toast(href){',
    'var t=document.getElementById("ap-toast");',
    'if(!t){t=document.createElement("div");t.id="ap-toast";',
    'document.body.appendChild(t);}',
    'clearTimeout(toastTimer);',
    't.innerHTML="";',
    'var msg=document.createElement("span");',
    'msg.textContent=hostOf(href)+" is not part of this offline copy. "',
    '+"Opening it leaves this file and needs a connection.";',
    'var go=document.createElement("a");',
    'go.href=href;go.target="_blank";go.rel="noopener";',
    'go.textContent="Open anyway";',
    // Opening in a new tab keeps the offline copy where it was, so choosing to
    // look does not mean losing the document.
    'go.addEventListener("click",function(){t.className="";});',
    'var hide=document.createElement("button");',
    'hide.type="button";hide.textContent="Dismiss";',
    'hide.addEventListener("click",function(){t.className="";});',
    't.appendChild(msg);t.appendChild(go);t.appendChild(hide);',
    't.className="on";',
    'toastTimer=setTimeout(function(){t.className="";},9000);}',
    // Links inside page content still point at the original files
    // (docs/x.html, ../index.html). Resolve them against the current page and
    // route internally; without this every cross-reference dead-ends.
    'function resolve(base,href){',
    'var parts=base.split("/");parts.pop();',
    'href.split("/").forEach(function(seg){',
    'if(seg===".."){parts.pop();}else if(seg!=="."&&seg!==""){parts.push(seg);}});',
    'return parts.join("/").replace(/\\.html?$/,"");}',
    // The About wiki links to every other wiki by absolute ardupilot.org URL,
    // as does cross-wiki body text, so offline those lead out of the document.
    // Map them back in when the target is here; leave the rest external.
    'function siteHref(href){',
    'var m=/^https?:\\/\\/(?:www\\.)?ardupilot\\.org(\\/.*)?$/i.exec(href);',
    'if(!m)return null;',
    'var rest=(m[1]||"").replace(/[?#].*$/,"");',
    'if(!rest||rest==="/")return "/";',
    'return rest.replace(/\\.html?$/,"");}',
    // Assigning an unchanged hash fires no hashchange, so a link back to the
    // page you are already on would do nothing without this.
    'function go(p){var h="#"+p;if(location.hash===h){route();}else{location.hash=h;}}',
    'function onLinkClick(e){',
    'var a=e.target.closest?e.target.closest("a[href]"):null;if(!a)return;',
    'var href=a.getAttribute("href");',
    'if(a.getAttribute("data-ap-external")!==null)return;',
    'if(!href||/^(mailto:|#)/.test(href))return;',
    'if(/^https?:/i.test(href)){',
    'var mapped=siteHref(href);',
    // Another host: the forum, the firmware server, cloud.ardupilot.org from
    // the sidebar. These are separate services rather than wiki content, so
    // there is no offline copy to route to and the link stays what it is. What
    // changes is that it no longer happens silently.
    'if(mapped===null){e.preventDefault();toast(a.href);return;}',
    // An ardupilot.org URL is wiki content, so it never leaves the file, for
    // the same reason a relative link does not: offline there is nothing at
    // the other end, and following it costs the reader the whole document.
    // Say the wiki is missing instead.
    'e.preventDefault();',
    'if(mapped==="/"){go("/");return;}',
    'var hit=lookup(mapped);',
    'go(hit!==undefined?hit:mapped);',
    'return;}',
    'var frag="";var h=href;var hi=h.indexOf("#");',
    'if(hi>=0){frag=h.slice(hi);h=h.slice(0,hi);}',
    'var target=resolve(current(),h);',
    // Never let a relative link leave the file. Outside it there is nothing to
    // resolve against, so following one lands on a broken URL and the reader
    // loses the document entirely - Sphinx links thumbnails to full-size
    // images, so this is easy to hit by accident.
    'e.preventDefault();',
    'var found=lookup(target);',
    'if(found!==undefined){go(target);',
    'if(frag){setTimeout(function(){var t=doc.querySelector(frag);',
    'if(t&&t.scrollIntoView)t.scrollIntoView();},50);}return;}',
    // Sphinx links every thumbnail to its full-size file, so these outnumber
    // the page links. Answer them from the index.
    'var iid=D.imgs?D.imgs[target]:undefined;',
    'if(iid!==undefined&&iid!==null){',
    'var blk=document.getElementById("i"+iid);',
    'if(blk){lightbox(blk.textContent);return;}}',
    // Scaled images link an original that no page displays, so it is not in
    // the file. The wrapped thumbnail is the same picture.
    'var inner=a.querySelector?a.querySelector("[data-ap-img]"):null;',
    'if(inner){',
    'var ib=document.getElementById("i"+inner.getAttribute("data-ap-img"));',
    'if(ib){lightbox(ib.textContent);return;}}',
    'showMissing(target);',
    '}',
    // The sidebar carries the absolute links, so it needs this too.
    'doc.addEventListener("click",onLinkClick);',
    'nav.addEventListener("click",onLinkClick);',
    // Search every page, not the sidebar.
    //
    // This used to hide non-matching entries in the navigation tree, which
    // only ever covered what the toctree lists: about a hundred headings out
    // of several thousand pages. Anything reached from within a page could not
    // be found at all. Titles and paths for the whole file are already in the
    // index, so matching against those costs nothing and covers all of it.
    'function esc(s){return String(s).replace(/[&<>"]/g,function(c){',
    'return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
    'function wikiName(p){var id=p.split("/")[1]||"";var out=id;',
    'D.homes.forEach(function(h){if(h.id===id)out=h.name||h.id;});return out;}',
    // Sphinx's index, parsed the first time somebody searches rather than on
    // load, so opening the file does not pay for it.
    'var SI=null;',
    'function searchIndex(){',
    'if(SI!==null)return SI;',
    'var el=document.getElementById("ap-fts");',
    'try{SI=el?JSON.parse(el.textContent):{};}catch(e){SI={};}',
    'return SI;}',
    // The index is stemmed, so the query has to be stemmed the same way or
    // "tuning" never matches the "tune" that is actually stored. This is
    // Sphinx's own stemmer, carried along with the index that it built.
    'var stemmer=(typeof Stemmer!=="undefined")?new Stemmer():null;',
    'function stem(w){return stemmer?stemmer.stemWord(w):w;}',
    // Sphinx leaves stopwords out of the index entirely, so requiring every
    // query word to match meant one "the" reduced the whole result set to
    // nothing. Anybody pasting a sentence got no results at all.
    'var STOP=(typeof stopwords!=="undefined")?stopwords:[];',
    // Edit distance with a budget, abandoning a row as soon as every cell in
    // it already exceeds what we will accept. Most candidates are rejected on
    // the length check without any work at all.
    'function within(a,b,max){',
    'if(Math.abs(a.length-b.length)>max)return false;',
    'var prev=[],i,j;for(j=0;j<=b.length;j++)prev[j]=j;',
    'for(i=1;i<=a.length;i++){',
    'var best=i,diag=prev[0];prev[0]=i;',
    'for(j=1;j<=b.length;j++){',
    'var cur=Math.min(prev[j]+1,prev[j-1]+1,diag+(a.charAt(i-1)===b.charAt(j-1)?0:1));',
    'diag=prev[j];prev[j]=cur;if(cur<best)best=cur;}',
    'if(best>max)return false;}',
    'return prev[b.length]<=max;}',
    'function fullText(ql){',
    'var idx=searchIndex();var out={};',
    'var words=ql.split(/[^a-z0-9_]+/).filter(function(w){',
    'return w.length>1&&STOP.indexOf(w)===-1;});',
    'if(!words.length)return out;',
    'var all=[],best=0;',
    'Object.keys(idx).forEach(function(w){',
    'var d=idx[w];var score={},cover={};',
    'words.forEach(function(word){',
    'var s=stem(word);var hit={};',
    'function mark(list,weight){',
    'if(list===undefined)return;',
    'if(typeof list==="number")list=[list];',
    'list.forEach(function(n){hit[n]=(hit[n]||0)+weight;});}',
    'mark(d.terms[s],1);mark(d.titleterms[s],5);',
    // A word still being typed should match by prefix, or results only appear
    // once the word is finished.
    'var keys=Object.keys(d.terms),k;',
    'if(word.length>=3){',
    'for(k=0;k<keys.length;k++){',
    'if(keys[k]!==s&&keys[k].indexOf(s)===0)mark(d.terms[keys[k]],0.5);}}',
    // Only when a word matched nothing at all is it worth treating as a typo.
    // A correctly spelled query never pays for this, and one edit is as far as
    // it goes: two starts matching words with no relation to what was typed.
    'if(word.length>=4&&!Object.keys(hit).length){',
    'for(k=0;k<keys.length;k++){',
    'if(within(s,keys[k],1))mark(d.terms[keys[k]],0.25);}}',
    // Count how many query words reached each document, alongside the score.
    'Object.keys(hit).forEach(function(n){',
    'score[n]=(score[n]||0)+hit[n];cover[n]=(cover[n]||0)+1;});});',
    'Object.keys(cover).forEach(function(n){',
    'if(cover[n]>best)best=cover[n];',
    'all.push({p:"/"+w+"/"+d.docnames[n],c:cover[n],s:score[n]});});});',
    // Requiring every word to match is fatal for a pasted sentence. A reader
    // dragging a selection clips the first and last words, so "industrial-
    // grade" arrives as "rial-grade": that matches other pages by one edit,
    // never the intended one, and intersecting emptied the whole result set.
    // Twenty-three further words all pointed at a single page - two of them,
    // "india" and "indigenous", appear on no other page in the wiki - and the
    // search still answered nothing found.
    //
    // Take the best-covered tier instead. When some page really does contain
    // every word this is exactly the old behaviour, because that page covers
    // all of them and nothing else can do better. When no page covers them
    // all, the closest pages surface rather than nothing.
    'all.forEach(function(r){',
    'if(r.c<best)return;',
    'out[r.p]=Math.max(out[r.p]||0,r.s);});',
    'return out;}',
    // One matcher, two views: the sidebar list and the full page both rank the
    // same way, so pressing Enter never reorders what was just on screen.
    'function matches(q){',
    'var ql=q.toLowerCase();var hits=[];var seen={};',
    'for(var i=0;i<D.pages.length;i++){',
    'var pg=D.pages[i];var at=pg.t.toLowerCase().indexOf(ql);',
    'var ap=at===-1?pg.p.toLowerCase().indexOf(ql):-1;',
    // Half-remembered page names are the common case for a title search, so a
    // single wrong letter should still find it. Titles are few and short, so
    // this costs nothing worth measuring.
    'if(at===-1&&ap===-1&&ql.length>=4){',
    'var tw=pg.t.toLowerCase().split(/[^a-z0-9]+/);',
    'for(var w=0;w<tw.length;w++){',
    'if(tw[w].length>=4&&within(ql,tw[w],1)){at=1;break;}}}',
    'if(at===-1&&ap===-1)continue;',
    // Title matches first, and a title that starts with the query above one
    // that merely contains it. Path-only matches last.
    'hits.push({pg:pg,i:i,rank:at===0?0:(at>0?1:2)});seen[pg.p]=1;}',
    // Then whatever the body text turns up, below the title matches.
    'var ft=fullText(ql);',
    'var byPathPage={},byPathIdx={};',
    'D.pages.forEach(function(p,n){byPathPage[p.p]=p;byPathIdx[p.p]=n;});',
    'Object.keys(ft).sort(function(a,b){return ft[b]-ft[a];}).forEach(function(p){',
    'if(seen[p]||!byPathPage[p])return;',
    'hits.push({pg:byPathPage[p],i:byPathIdx[p],rank:3});});',
    'hits.sort(function(a,b){return a.rank-b.rank||(a.pg.t<b.pg.t?-1:1);});',
    'return hits;}',

    'function renderSearch(q){',
    'var hits=matches(q);',
    'var words=q.toLowerCase().split(/[^a-z0-9_]+/).filter(function(w){',
    'return w.length>1&&STOP.indexOf(w)===-1;});',
    'var shown=hits.slice(0,60);',
    'var rows=shown.map(function(h){',
    'return \'<li><a href="#\'+h.pg.p+\'"><span>\'+esc(h.pg.t)+\'</span>\'',
    '+\'<small>\'+esc(wikiName(h.pg.p))+\'</small></a>\'',
    '+\'<p class="ap-snip">\'+snippet(h.i,words)+\'</p></li>\';}).join("");',
    'doc.innerHTML="<h1>Search</h1><p>"+hits.length+" page"',
    '+(hits.length===1?"":"s")+" matching <strong>"+esc(q)+"</strong>"',
    '+(hits.length>shown.length?", showing the first "+shown.length:"")+"</p>"',
    '+(hits.length?"<ul id=\\"ap-pick\\" class=\\"ap-results\\">"+rows+"</ul>":"");',
    'crumb.textContent="";',
    'var sc=document.querySelector(".wy-nav-content-wrap");if(sc)sc.scrollTop=0;}',
    // A few hundred characters of the page around the first match, so a result
    // can be judged without opening it. Pulled from the inert page block and
    // stripped of markup; only done for the handful of results on screen.
    'function snippet(i,words){',
    'var el=document.getElementById("p"+i);if(!el)return "";',
    'var text=el.textContent.replace(/<[^>]*>/g," ").replace(/\\s+/g," ");',
    'var low=text.toLowerCase(),at=-1,hit="";',
    'for(var w=0;w<words.length;w++){',
    'var p=low.indexOf(words[w]);',
    'if(p!==-1&&(at===-1||p<at)){at=p;hit=words[w];}}',
    'if(at===-1)return text.slice(0,160)+"\u2026";',
    'var from=Math.max(0,at-70),to=Math.min(text.length,at+hit.length+130);',
    'return (from?"\u2026":"")+esc(text.slice(from,at))+"<mark>"',
    '+esc(text.slice(at,at+hit.length))+"</mark>"+esc(text.slice(at+hit.length,to))',
    '+(to<text.length?"\u2026":"");}',

    // Typing filters the sidebar and leaves the document alone: someone
    // searching has not asked to leave the page they are reading. Enter is
    // what commits to the full result list.
    'var navHtml=null;',
    'function restoreNav(){if(navHtml!==null){nav.innerHTML=navHtml;navHtml=null;',
    'links=[].slice.call(nav.querySelectorAll(\'a[href^="#"]\'));}}',
    'function sidebarResults(q,hits){',
    'if(navHtml===null)navHtml=nav.innerHTML;',
    'var rows=hits.slice(0,40).map(function(h){',
    'return \'<li class="toctree-l1"><a href="#\'+h.pg.p+\'">\'+esc(h.pg.t)+\'</a></li>\';',
    '}).join("");',
    'nav.innerHTML=\'<p class="caption">\'+hits.length+\' result\'+(hits.length===1?"":"s")',
    '+\'</p><ul>\'+(rows||\'<li class="toctree-l1"><a href="#">nothing found</a></li>\')+\'</ul>\';}',

    'var searchTimer=null,beforeSearch=null;',
    'search.addEventListener("input",function(){',
    'clearTimeout(searchTimer);',
    'searchTimer=setTimeout(function(){',
    'var q=search.value.trim();',
    'if(q.length<2){restoreNav();',
    'if(beforeSearch!==null){var b=beforeSearch;beforeSearch=null;go(b);}return;}',
    'sidebarResults(q,matches(q));},120);});',
    // Enter opens the full list, with context, without having disturbed
    // anything up to that point.
    'search.addEventListener("keydown",function(e){',
    'if(e.key!=="Enter")return;e.preventDefault();',
    'var q=search.value.trim();if(q.length<2)return;',
    'if(beforeSearch===null)beforeSearch=current()||"/";',
    'renderSearch(q);});',
    'window.addEventListener("hashchange",function(){beforeSearch=null;restoreNav();});',
    'document.addEventListener("keydown",function(e){',
    'if(e.key==="Escape"){var lb=document.getElementById("ap-lightbox");',
    'if(lb)lb.style.display="none";',
    'if(document.activeElement===search&&search.value){',
    'search.value="";search.dispatchEvent(new Event("input"));}}',
    'if(e.key==="/"&&document.activeElement!==search){e.preventDefault();search.focus();}});',
    'route();})();'
  ].join('');

  /**
   * Fallback navigation: a flat list of the wiki's pages.
   *
   * Used when the toctree cannot be recovered - the wiki's index page was not
   * part of this export, or carries no navigation. A plain list is poor
   * compared with the real structure, but an empty sidebar makes the file
   * unusable, and that is what happened before.
   */
  function listNav(pages, wiki) {
    var items = pages.filter(function (p) {
      return p.path.split('/')[1] === wiki;
    }).map(function (p) {
      var anchor = p.path.replace(/\.html?$/, '');
      var label = anchor.split('/').pop().replace(/[-_]/g, ' ');
      return '<li class="toctree-l1"><a class="reference internal" href="#' +
             anchor + '">' + label + '</a></li>';
    });
    return '<ul>' + items.join('') + '</ul>';
  }

  /**
   * Inner HTML of an element, found by counting nested tags rather than
   * stopping at the first closing one.
   */
  function innerOf(html, openRe, tag) {
    var open = openRe.exec(html);
    if (!open) { return ''; }
    var from = open.index + open[0].length;
    var scan = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    scan.lastIndex = from;
    var depth = 1, m;
    while ((m = scan.exec(html)) !== null) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) { return html.slice(from, m.index); }
    }
    return html.slice(from);
  }

  /** The balanced top-level <ul> blocks in a fragment, and nothing else. */
  function topLevelLists(inner) {
    var out = '', re = /<(\/?)ul\b[^>]*>/gi, depth = 0, start = -1, m;
    while ((m = re.exec(inner)) !== null) {
      if (!m[1]) {
        if (depth === 0) { start = m.index; }
        depth++;
      } else if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out += inner.slice(start, m.index + m[0].length);
          start = -1;
        }
      }
    }
    return out;
  }

  // Listing order for the picker, most recognisable first. Anything else
  // follows alphabetically.
  var HOME_ORDER = ['ardupilot', 'copter', 'plane', 'rover'];

  // Directory names are not product names. Kept in step with DISPLAY_NAMES in
  // scripts/build_offline_artifacts.py.
  var DISPLAY_NAMES = {
    ardupilot: 'About ArduPilot', copter: 'Copter', plane: 'Plane',
    rover: 'Rover', sub: 'Sub', blimp: 'Blimp', dev: 'Developer',
    antennatracker: 'Antenna Tracker', planner: 'Mission Planner',
    planner2: 'APM Planner 2', mavproxy: 'MAVProxy'
  };

  /** Front page and page count for each wiki in the export, in listing order. */
  function wikiHomes(index, wikis) {
    var homes = wikis.map(function (w) {
      var prefix = '/' + w + '/';
      var root = null, first = null, count = 0;
      index.forEach(function (p) {
        if (p.p.indexOf(prefix) !== 0) { return; }
        count++;
        if (!first) { first = p.p; }
        if (p.p === prefix + 'index') { root = p.p; }
      });
      return { id: w, name: DISPLAY_NAMES[w] || w, path: root || first,
               pages: count };
    }).filter(function (h) { return h.path; });

    return homes.sort(function (a, b) {
      var ai = HOME_ORDER.indexOf(a.id), bi = HOME_ORDER.indexOf(b.id);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }
      return a.id < b.id ? -1 : 1;
    });
  }

  /**
   * Sphinx's own search index, trimmed to what searching needs.
   *
   * The file is `Search.setIndex({...})`, so the JSON sits between the outer
   * brackets. Dropping objects, indexentries, alltitles and filenames halves
   * it: 11 MB across eleven wikis becomes 5 MB, against a 970 MB export.
   */
  function readSearchIndex(entry) {
    return entry.cache.match(entry.path)
      .then(function (r) { return r.text(); })
      .then(function (src) {
        var open = src.indexOf('('), close = src.lastIndexOf(')');
        if (open === -1 || close <= open) { return null; }
        var d = JSON.parse(src.slice(open + 1, close));
        if (!d.terms || !d.docnames) { return null; }
        return { docnames: d.docnames, titles: d.titles || [],
                 terms: d.terms, titleterms: d.titleterms || {} };
      })
      .catch(function () { return null; });
  }

  /**
   * Lift the theme's navigation tree out of a wiki's index page.
   *
   * Only the toctree lists: the same div carries a donation form whose links
   * are live and useless offline. Matching to the first </div> lands inside
   * that form and returns an unbalanced fragment, which nests each wiki's
   * navigation inside the last one when they are joined.
   */
  function extractNav(html, wiki) {
    var inner = innerOf(
      html, /<div class="wy-menu wy-menu-vertical"[^>]*>/i, 'div');
    var lists = topLevelLists(inner);
    if (!lists) { return ''; }
    // Hrefs in the root index are relative to the wiki root, so they map
    // straight onto our anchors once the extension is dropped.
    return lists.replace(/href="([^"#]+)(#[^"]*)?"/g, function (all, href) {
      if (/^(https?:|mailto:)/.test(href)) { return all; }
      // A leading slash means the href is already a path from the site root,
      // not from this wiki. Archives arrive that way: rewrite_site_links turns
      // the absolute cross-wiki links in the About wiki's sidebar into
      // /copter/index.html. Prefixing those with the wiki being read produced
      // #/ardupilot//copter/index, which resolves to nothing, so every
      // cross-wiki sidebar entry landed on "Not in this offline copy" even
      // when that wiki was sitting in the same file.
      var path = href.replace(/\.html?$/, '');
      return 'href="#' +
             (href.charAt(0) === '/' ? path : '/' + wiki + '/' + path) + '"';
    });
  }

  /**
   * Assemble one self-contained HTML file from the cached pages.
   *
   * Images are inlined as data URIs, the shared common set included: a single
   * file cannot reference an archive beside it. Written straight to the stream
   * page by page, because the finished file runs to hundreds of megabytes and
   * cannot be built as a string first.
   */
  function exportHtml(wikiIds, filename, onProgress, sink) {
    var enc = new TextEncoder();

    return storedEntries(wikiIds).then(function (groups) {
      var pages = [], assets = {}, styles = {}, roots = {};
      // Sphinx already built a stemmed full-text index per wiki, and the
      // stemmer that built it. Both are sitting in the cache.
      var indexes = {}, stemmerSrc = null;

      groups.forEach(function (g) {
        g.reqs.forEach(function (req) {
          var path = new URL(req.url).pathname;
          if (path === COMPLETE_MARKER) { return; }
          var si = path.match(/^\/([^/]+)\/searchindex\.js$/);
          if (si) { indexes[si[1]] = { cache: g.cache, path: path }; return; }
          if (/\/_static\/language_data\.js$/.test(path)) {
            if (!stemmerSrc) { stemmerSrc = { cache: g.cache, path: path }; }
            return;
          }
          if (BINARY.test(path)) { assets[path] = g.cache; }
          else if (/\.css$/.test(path)) { styles[path] = g.cache; assets[path] = g.cache; }
          else if (/\.html?$/.test(path)) {
            pages.push({ path: path, cache: g.cache });
            if (/^\/[^/]+\/index\.html$/.test(path)) {
              roots[path.split('/')[1]] = { cache: g.cache, path: path };
            }
          }
        });
      });

      if (!pages.length) {
        throw new Error('Nothing is saved yet - download a wiki first.');
      }
      pages.sort(function (a, b) { return a.path < b.path ? -1 : 1; });

      // Build the navigation from each wiki's own toctree, so the structure is
      // the wiki's rather than an alphabetical list of every file.
      // Group by wiki from the pages themselves, so a wiki still appears even
      // if its index page was not part of the export.
      var wikis = [];
      pages.forEach(function (pg) {
        var w = pg.path.split('/')[1];
        if (w && wikis.indexOf(w) === -1) { wikis.push(w); }
      });
      wikis.sort();

      return Promise.all(wikis.map(function (w) {
        var caption = '<p class="caption">' + w + '</p>';
        if (!roots[w]) {
          return Promise.resolve(caption + listNav(pages, w));
        }
        return roots[w].cache.match(roots[w].path)
          .then(function (r) { return r.text(); })
          .then(function (html) {
            var nav = extractNav(html, w);
            // An index page without a usable toctree is no better than none.
            return caption + (nav.indexOf('href="#') === -1 ? listNav(pages, w) : nav);
          })
          .catch(function () { return caption + listNav(pages, w); });
      })).then(function (navParts) {
        var navHtml = navParts.join('');
        return buildThemeCss(styles, assets).then(function (themeCss) {
        return (sink ? Promise.resolve(sink) : openDownload(filename))
        .then(function (sink) {
          var done = 0, index = [];
          // Shared across pages so each image is emitted once.
          var imgIds = { __next: 0 };
          // Image path as pages spell it -> the id of the block holding it,
          // so a link to an image can be answered from what is already here.
          var imgPaths = {};
          var write = function (text) { return sink.write(enc.encode(text)); };

          return write(
            '<!DOCTYPE html><html lang="en" class="writer-html5"><head>' +
            '<meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>ArduPilot wiki (offline)</title>' +
            '<style>' + themeCss + '</style><style>' + SHELL_CSS + '</style>' +
            '</head><body class="wy-body-for-nav">' +
            '<div class="wy-grid-for-nav">' +
            '<nav data-toggle="wy-nav-shift" class="wy-nav-side">' +
            '<div id="ap-brand">ArduPilot<small>offline copy &middot; ' +
            wikis.join(', ') + '</small></div>' +
            '<input id="ap-search" placeholder="Search all pages  ( / )" autocomplete="off">' +
            '<div class="wy-menu wy-menu-vertical" id="ap-nav"></div></nav>' +
            '<section data-toggle="wy-nav-shift" class="wy-nav-content-wrap">' +
            '<div class="wy-nav-content"><div class="rst-content">' +
            '<div id="ap-bar">Offline copy built from pages saved on your device. ' +
            'It does not update itself.</div>' +
            '<div id="ap-miss"></div><div id="ap-crumb"></div>' +
            '<div itemprop="articleBody" id="ap-doc"></div>' +
            '</div></div></section></div>'
          ).then(function () {
            var chain = Promise.resolve();
            pages.forEach(function (p, i) {
              chain = chain.then(function () {
                return p.cache.match(p.path)
                  .then(function (res) { return res.text(); })
                  .then(function (html) {
                    var title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] ||
                                p.path.replace(/^\//, '');
                    // Strip the theme's " <dash> Project documentation" suffix.
                    // The dashes are what Sphinx emits, so the split spells them.
                    title = title.split('&mdash;')[0].split(' — ')[0].trim();
                    index.push({ t: title, p: p.path.replace(/\.html?$/, '') });

                    var m = html.match(/<div[^>]*itemprop="articleBody"[^>]*>([\s\S]*?)<\/div>\s*<footer/i);
                    return referenceImages(m ? m[1] : html, assets, p.path,
                                           imgIds, imgPaths);
                  })
                  .then(function (r) {
                    done++;
                    if (onProgress && done % 10 === 0) { onProgress(done, pages.length); }
                    var body = r.html.split('</script>').join('<\\/script>');
                    // Images seen for the first time are written now, once.
                    var blocks = r.fresh.map(function (f) {
                      return '<script type="text/plain" id="i' + f.id + '">' +
                             f.uri + '<\/script>';
                    }).join('');
                    return write(blocks + '<script type="text/plain" id="p' + i + '">' +
                                 body + '<\/script>');
                  });
              });
            });
            return chain;
          }).then(function () {
            // With one wiki there is nothing to choose, so open it directly.
            // With several, opening on one of them is a guess: show the list.
            var homes = wikiHomes(index, wikis);
            var payload = { pages: index, nav: navHtml, wikis: wikis,
                            imgs: imgPaths, homes: homes,
                            home: homes.length === 1 ? homes[0].path : '' };

            // Full-text search, written as its own inert block rather than
            // folded into the routing payload. That one is parsed on load; a
            // few megabytes of index is not, and is only read the first time
            // somebody searches.
            var wantIndex = wikis.filter(function (w) { return indexes[w]; });
            return Promise.all(wantIndex.map(function (w) {
              return readSearchIndex(indexes[w]).then(function (d) {
                return d ? [w, d] : null;
              });
            })).then(function (loaded) {
              var byWiki = {};
              loaded.forEach(function (e) { if (e) { byWiki[e[0]] = e[1]; } });
              var stem = stemmerSrc
                ? stemmerSrc.cache.match(stemmerSrc.path)
                    .then(function (r) { return r.text(); })
                    .catch(function () { return ''; })
                : Promise.resolve('');
              return stem.then(function (stemSrc) {
                return write(
                  '<script type="application/json" id="ap-fts">' +
                  JSON.stringify(byWiki).split('</').join('<\\/') +
                  '<\/script>' +
                  (stemSrc ? '<script>' + stemSrc.split('<\/script>')
                                                  .join('<\\/script>') +
                             '<\/script>' : ''));
              });
            }).then(function () {
              return write('<script type="application/json" id="ap-index">' +
                           JSON.stringify(payload).split('</').join('<\\/') +
                           '<\/script><script>' + SHELL_JS + '<\/script></body></html>');
            });
          }).then(function () { return sink.close(); })
            .then(function () { return { pages: done }; });
        });
        });
      });
    });
  }

  /**
   * Rebuild the theme's stylesheet with its fonts inlined.
   *
   * Without this the export approximates the theme: admonitions, code blocks,
   * tables and inline literals all render plain, and the type falls back to
   * Helvetica because Lato and Roboto Slab are loaded by @font-face. All of it
   * is already in the cache, so using it is a few hundred kilobytes on a file
   * that is already hundreds of megabytes.
   */
  function buildThemeCss(styles, assets) {
    var wanted = Object.keys(styles).filter(function (p) {
      return /_static\/css\/(theme|badge_only)\.css$/.test(p) ||
             /_static\/(ardupilot|custom)\.css$/.test(p);
    }).sort();
    if (!wanted.length) { return Promise.resolve(''); }

    // One wiki's copy is enough - they are identical across wikis.
    var seen = {};
    wanted = wanted.filter(function (p) {
      var base = p.replace(/^\/[^/]+\//, '');
      if (seen[base]) { return false; }
      seen[base] = 1;
      return true;
    });

    var chain = Promise.resolve('');
    wanted.forEach(function (path) {
      chain = chain.then(function (acc) {
        return styles[path].match(path)
          .then(function (r) { return r.text(); })
          .then(function (css) { return inlineCssUrls(css, path, assets); })
          .then(function (css) { return acc + '\n' + css; })
          .catch(function () { return acc; });
      });
    });
    return chain;
  }

  /** Replace url(...) in a stylesheet with data URIs from the cache. */
  function inlineCssUrls(css, cssPath, assets) {
    var refs = [];
    css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, function (all, ref) {
      if (!/^(data:|https?:|\/\/)/.test(ref) && refs.indexOf(ref) === -1) {
        refs.push(ref);
      }
      return all;
    });
    if (!refs.length) { return Promise.resolve(css); }

    var chain = Promise.resolve(css);
    refs.forEach(function (ref) {
      chain = chain.then(function (current) {
        var clean = ref.split('?')[0].split('#')[0];
        var resolved = clean.charAt(0) === '/' ? clean : resolvePath(cssPath, clean);
        if (!assets[resolved]) { return current; }
        return assets[resolved].match(resolved)
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) {
            var uri = 'data:' + mimeFor(resolved) + ';base64,' +
                      base64(new Uint8Array(buf));
            return current.split(ref).join(uri);
          })
          .catch(function () { return current; });
      });
    });
    return chain;
  }

  /** Resolve a relative href against a page path, as a browser would. */
  function resolvePath(basePath, href) {
    var parts = basePath.split('/');
    parts.pop();                       // drop the page's own filename
    href.split('/').forEach(function (seg) {
      if (seg === '..') { parts.pop(); }
      else if (seg && seg !== '.') { parts.push(seg); }
    });
    return parts.join('/');
  }

  /**
   * Point each <img> at a shared image block instead of inlining it.
   *
   * Inlining per page encodes the same picture once for every page that shows
   * it - a diagram used on forty pages was written forty times, which is what
   * made a full export enormous. Each image is now emitted once as its own
   * inert block and referenced by id, so the file holds one copy of each
   * regardless of how many pages use it.
   *
   * Returns the rewritten html plus any images seen for the first time, which
   * the caller writes out as it streams.
   */
  function referenceImages(html, assets, pagePath, imgIds, imgPaths) {
    var srcs = [];
    html.replace(/<img[^>]+src="([^"]+)"/gi, function (all, src) {
      if (srcs.indexOf(src) === -1) { srcs.push(src); }
      return all;
    });
    if (!srcs.length) { return Promise.resolve({ html: html, fresh: [] }); }

    var fresh = [];
    var chain = Promise.resolve(html);

    srcs.forEach(function (src) {
      chain = chain.then(function (current) {
        if (/^(data:|https?:|\/\/)/.test(src)) { return current; }

        var clean = src.split('?')[0].split('#')[0];
        var resolved = clean.charAt(0) === '/' ? clean : resolvePath(pagePath, clean);
        var candidates = [
          resolved,
          resolved.replace(/^\/[^/]+\/_images\//, '/_common/_images/')
        ];

        var hit = null;
        candidates.forEach(function (c) { if (!hit && assets[c]) { hit = c; } });
        if (!hit) {
          // Leaving the relative src in place points at nothing once the page
          // is inside a single file, and shows as a silently blank space.
          // Drop the src so the alt text renders and the gap is legible.
          return current.split('src="' + src + '"')
                        .join('data-ap-missing="' + src + '"');
        }

        // Record the path as the page spells it, so a link to this image can
        // be answered from the copy already in the file.
        // Already emitted for an earlier page: just point at it.
        if (imgIds[hit] !== undefined) {
          if (imgPaths) { imgPaths[resolved] = imgIds[hit]; }
          return current.split('src="' + src + '"')
                        .join('data-ap-img="' + imgIds[hit] + '"');
        }

        var id = imgIds[hit] = imgIds.__next++;
        if (imgPaths) { imgPaths[resolved] = id; }
        return assets[hit].match(hit)
          .then(function (res) { return res.arrayBuffer(); })
          .then(function (buf) {
            fresh.push({
              id: id,
              uri: 'data:' + mimeFor(hit) + ';base64,' + base64(new Uint8Array(buf))
            });
            return current.split('src="' + src + '"')
                          .join('data-ap-img="' + id + '"');
          })
          .catch(function () { return current; });
      });
    });

    return chain.then(function (out) { return { html: out, fresh: fresh }; });
  }

  global.ArduPilotExport = {
    exportHtml: exportHtml,
    openDownload: openDownload
  };
})(window);
