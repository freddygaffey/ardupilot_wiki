# Bugs found in the wiki, not caused by the offline work

Each of these was hit while building offline copies, and each is a pre-existing
fault in the wiki, its build scripts, or its theme. They are recorded here
rather than worked around silently, because a workaround in the offline code
would hide a problem that affects the live site too.

Companion to `KNOWN_MARKUP_ISSUES.md`, which covers content that is not
well-formed XML.

None of these are fixed by the offline branch. Each needs a decision from
whoever owns the code in question.

---

## 1. `build_parameters.py` fetches only `master`, then checks out commits that are not on it

**Where:** `build_parameters.py`, `setup()`

**Symptom:** the run appears to work, then produces empty vehicle directories
and no parameter files at all. The error is buried among hundreds of lines:

```
[ERROR]: Git command failed: git checkout --force de5add012ea2155c8dabc57270c8520a189c7208
[ERROR]: Error: fatal: unable to read tree (de5add012ea2155c8dabc57270c8520a189c7208)
```

`../new_params_mversion/` is then created with a directory per vehicle and
nothing in any of them, which reads like a permissions or path problem rather
than a missing git object.

**Cause:** `setup()` runs

```sh
git fetch origin master
```

but the versions to build come from `firmware.ardupilot.org` and are checked
out **by commit hash**, and those commits live on release branches and tags.
A clone that has only ever fetched `master` does not contain them.

**Reproduce:** on a clone that has not fetched tags,

```sh
git -C ../ardupilot cat-file -t de5add012ea2155c8dabc57270c8520a189c7208
# fatal: git cat-file: could not get object info
```

**Confirmed fix:** fetching every ref makes the object present, with no other
change:

```sh
git -C ../ardupilot fetch --all --tags
git -C ../ardupilot cat-file -t de5add012ea2155c8dabc57270c8520a189c7208
# commit
```

The offline branch adds that fetch to `setup()`.

**Worth noting:** the script also force-checks-out `master` over whatever branch
is present, and `git clean -f -d`, so it will discard uncommitted work in the
firmware repo without warning. Anyone running it by hand should check the repo
is clean first.

---

## 2. The donate button cannot render without a network, and shows nothing when it fails

**Where:** `sphinx_rtd_theme/z_sidebar_additions.html` (ArduPilot's fork of the
theme, a separate repository), present on all 3,958 pages.

```html
<form style="margin:auto;" action="https://ardupilot.org/donate">
<input type="image" src="https://www.paypalobjects.com/en_US/i/btn/btn_donate_LG.gif"
       border="0" name="submit" title="PayPal - The safer, easier way to pay online!"
       alt="Donate" />
</form>
```

**Symptom:** offline, the image cannot load and a broken `<input type="image">`
renders as a small grey box. The `alt="Donate"` is not shown, so the control
reads as nothing at all: not a button, not a link, not an error.

**Why it matters beyond offline:** any reader whose network blocks
`paypalobjects.com`, which ad and tracker blockers commonly do, sees the same
grey box on every page of the wiki.

**Suggested fix, at the source:** an `<a>` styled as a button, or a locally
hosted image. Either keeps the control meaningful when the remote asset does
not arrive.

The offline branch rewrites it inside archived copies only
(`rewrite_donate()` in `scripts/build_offline_artifacts.py`), because the theme
is a repository this one cannot change. `scripts/tests/test_offline_archives.py`
asserts no archived page still references `paypalobjects`, so a theme change
that alters this markup fails a check rather than silently reaching readers.

---

## 3. `images/rpanion.png` is referenced by every wiki and copied into none

**Where:** `common/source/docs/common-commercial-support.rst`, which is copied
into all 11 wikis.

**Symptom:** a broken image on `common-commercial-support` in every wiki,
**including on the live site.** This is not an offline-only fault.

**Reproduce:**

```sh
ls images/rpanion.png                       # exists in source
ls */build/html/_images/rpanion.png         # copied nowhere
```

Measured across a full build: of 13,295 image references in 11 wikis, this is
the only one that resolves to nothing. Every other image is present.

---

## 4. `update.cron` and `update.sh` disagree about where the build lives

**Where:** `scripts/update.cron` and `update.sh`.

`update.cron` does

```sh
cd $HOME/build_wiki
cp $HOME/build_wiki/ardupilot_wiki/update.sh $HOME/cron
```

while `update.sh` itself does

```sh
cd $HOME/ardupilot_wiki
...
pushd ardupilot_wiki
```

so one expects the checkout at `$HOME/build_wiki/ardupilot_wiki` and the other
at `$HOME/ardupilot_wiki/ardupilot_wiki`. Both cannot be right. Anyone standing
up a build server from these scripts hits it immediately, and the failure is a
`cd` that silently lands somewhere unexpected.

---

## 5. The generated reference pages are large enough to hang a browser

**Where:** generated by the build, not authored.

| page | size | DOM elements |
| --- | --- | --- |
| `copter/docs/binary-features.html` | 8.0 MB | not measured |
| `copter/docs/parameters.html` | 5.8 MB | 215,470 |

**Measured on `parameters.html`,** served from cache with zero network
requests:

```
HTML arrived           321 ms
domInteractive      33,512 ms
domComplete         38,206 ms
```

Thirty-three seconds before the page responds, and in repeated testing it froze
the renderer outright: Chrome stopped answering automation commands entirely.
Jumping to an anchor such as `#brd-alt-config` appears to "take a second"
because the browser reaches that point partway through a layout that runs for
half a minute.

**Not a caching or hosting problem.** Nothing is being fetched. A
`content-visibility: auto` rule for these pages (in `common/_templates/layout.html`
on the offline branch) reduces layout work but did not make the page usable.

**Suggested fix:** split the page. `--paramversioning` already produces one
page per firmware version, which would divide it several ways as a side effect.
Worth measuring whether that alone brings it under control.

---

## 6. The wiki links to itself by absolute URL in a few hundred places

**Where:** 212 links across 98 `.rst` files, plus about ten per page injected by
`sphinx_rtd_theme/z_sidebar_additions.html` and `common/_templates/z_top_menu.html`,
giving 38,977 across a full build.

Harmless on `ardupilot.org`, where they are same-origin. On any mirror, staging
site or offline copy they walk the reader back to the live site, and offline
they fail outright.

`common_conf.py` already has `wiki_base_url = 'https://ardupilot.org/'` but uses
it only for intersphinx. Making it the single source for the site's own address
would let a mirror differ by one value.

Note the distinction that has to survive any such change: of the 212 source
links, about 182 point at wiki content and should follow the site, while
roughly 26 are genuinely different services (`/discord` 24, `/donate` 2, plus
the firmware server and the forum) and must stay absolute.

---

## 7. The wiki's PNGs have never been through a lossless optimiser

**Where:** the images themselves, wherever authors added them.

Images arrive from whatever tool each contributor happened to use, and nothing
in the build re-deflates them. Re-encoding losslessly, same dimensions, same
colours, no artefacts, recovers a useful amount for nothing:

| file | before | after | saved |
| --- | --- | --- | --- |
| `AEROFOX-H7_IMG.png` | 12.7 MB | 6.0 MB | 53% |
| `H743StampFrontBack.png` | 3.8 MB | 3.1 MB | 19% |
| `JHEMCU-H743HD-Uart-pins.png` | 3.8 MB | 3.4 MB | 10% |
| `AEROFOX-H7_pinout.png` | 8.3 MB | 8.1 MB | 2% |

Measured across a sample of the largest: **16% saved, pixel-identical.** The
spread is wide because some files were already well compressed and some were
not compressed at all.

There are 5,787 PNGs across the eleven wikis. The shared image set alone
carries 282 MB of them.

**Why lossless and not something with a better ratio.** JPEG or WebP would save
considerably more, and both were measured: JPEG at q85 gave 69% on these files.
But the saving is worst exactly where the risk is highest. `AEROFOX-H7_pinout.png`
is a 9,449px pinout diagram, deliberately large so pin labels stay readable
when zoomed, and it gives back only 28% to JPEG while gaining ringing artefacts
along every hard edge. Resizing has the same problem: a cap at 800px would
touch 1,239 of 2,331 images, and Sphinx links every thumbnail to the full-size
file, so shrinking the original also removes the zoomed view a reader gets by
clicking.

**What the offline branch does, and does not do.** `shrink_png()` in
`scripts/build_offline_artifacts.py` recompresses PNGs **only on the way into
the downloadable archives.** The built site is read and never written, so the
wiki as served is byte-for-byte unchanged and this cannot affect anyone who is
not downloading an offline copy. It falls back to the original bytes if Pillow
is absent, if anything raises, or if the result is not actually smaller.
Results are cached by content hash in `offline/.png-cache`, since the work is
identical on every build.

**For upstream: compress on the way out, not in the repository.**

The obvious version of this is to recompress the images and commit them. The
better version is to do it in the build, as a step over the output before it is
served. The repository keeps the originals exactly as authors supplied them,
nothing changes for contributors, every future image is covered without anyone
remembering to do it, and there is no large commit touching thousands of binary
files for reviewers to take on trust.

The cost is build time, and it is bounded: results cache on the content hash,
so the work happens once per distinct image rather than once per build. The
offline branch already does exactly this for the downloadable archives
(``shrink_png()`` in ``scripts/build_offline_artifacts.py``), and applying the
same pass to the built site is a small extension of it.

**This belongs in its own change, not in the offline work.** The offline branch
touches only what it packs into archives, so the site as served is unaffected
by it. Compressing the served output changes what every reader receives, which
is a separate decision and deserves to be reviewed as one.

If proposed, the argument is:

* **It is lossless.** Dimensions, colours and every pixel are unchanged; only
  the deflate stream is redone. No diagram, screenshot or pinout degrades, and
  it can be verified by decoding both and comparing.
* **The saving is real but uneven**, so claim it honestly: 16% across a sample
  of the largest files, with individual results from 53% down to nothing.
  Files an author already optimised give back little; files exported straight
  from a tool give back a lot.
* **It fails safe.** Return the original bytes when the encoder is unavailable,
  when anything raises, or when the result is not actually smaller. A build
  must never break because an image could not be recompressed.

Anything requiring re-encoding, resizing, or a format change (JPEG, WebP, AVIF)
is a different proposal with different trade-offs, and should not be mixed into
this one. Those were measured too: JPEG at q85 gives 69% on the same files, but
returns least on the pinout diagrams where its artefacts would matter most.
