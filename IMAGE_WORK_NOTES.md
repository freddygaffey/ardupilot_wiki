# Image work: what's left on the table

Measured on the eleven-wiki build of 2026-08-28. Every figure here came from
running it, not from estimating. Sizes are **distinct** images unless stated;
the built site keeps a copy per wiki, so bytes served are roughly 4x these.

## The corpus

| | distinct files | distinct MB | as served |
| --- | ---: | ---: | ---: |
| PNG | 1,635 | 354 MB | 1,364 MB |
| JPEG | 1,530 | 287 MB | 1,009 MB |
| other (gif/svg/bmp) | ~290 | 20 MB | 20 MB |

Both formats are dominated by a thin tail. The largest 1% of PNGs hold 23% of
PNG bytes; the largest 20 JPEGs hold 33% of JPEG bytes. **Anything that targets
the top ~40 files beats anything that targets all 3,165.**

## Ranked by value for effort

| # | work | saving | files touched | code |
| --- | --- | ---: | ---: | --- |
| 1 | Resize oversized JPEGs | **87 MB** | 20 | none |
| 2 | Delete unreferenced images | **48 MB** | 356 | none |
| 3 | Resize oversized PNGs | ~28 MB | 14-19 | none |
| 4 | *(merged PR: lossless PNG)* | *133 MB served* | *1,635* | *281 lines* |
| 5 | Lossless JPEG optimisation | unmeasured | ~1,530 | small |
| 6 | WebP lossless | +20% on PNG | all | large, risky |

---

## 1. Oversized JPEGs — the single best opportunity

**All 20 of the largest JPEGs are over 2000px.** Not most. All of them.

| file | dimensions | size |
| --- | --- | ---: |
| `Landmark_Module_Holybro_X500.jpg` | 4284×4284 | 16.73 MB |
| `Cubepilot_ecosystem.jpg` | 4098×5464 | 9.85 MB |
| `Hwing-access-cover.jpg` | 3009×3682 | 5.97 MB |
| `soar-cover.jpg` | 4918×3092 | 5.95 MB |
| `Landmark_Module_Mounted.jpg` | 3648×3648 | 5.78 MB |
| `ceeline_inplace.jpg` | 4000×3000 | 5.68 MB |

Those 20 files are **95.7 MB**. Resized to a 2000px long side at q85:
**8.3 MB, a 91% cut.** Even keeping full resolution and only re-encoding at q92
with optimised Huffman tables gives 54%.

These are photographs, so JPEG re-encoding is entirely appropriate: no text, no
hard edges, none of the objections that apply to pinout diagrams. A 4284×4284
photo of a mounting bracket serves nobody; no display shows it and phones
struggle to decode it.

**87 MB from twenty files, with no code at all.** That is two thirds of what the
entire lossless PNG PR achieves across 1,635 images.

## 2. Unreferenced images

**356 source images, 47.7 MB**, appear in no built page and are named in no
`.rst` file. Largest: `flywooF745.png` (4.97 MB),
`openpilot-revo-mini-flashed.jpg` (1.54 MB), `teraranger-tower-serial.png`
(1.28 MB).

**Verify before deleting.** The check was: name absent from every
`<wiki>/build/html/_images/` and absent from the text of every `.rst` under
`*/source/docs` and `common/source/docs`. It would miss an image referenced from
an `.rst` outside those directories, from a template, or by a page that failed to
build. Treat the 356 as candidates, not a delete list.

Note this saves repository size, not bytes served: Sphinx never copies them, so
readers already don't download them. Worth doing for repo hygiene rather than
for speed. Also note git keeps deleted blobs forever, so the clone does not
actually shrink.

## 3. Oversized PNGs

19 PNGs are over 2 MB and hold 23.5% of all PNG bytes. Capping the largest 14 at
2000px takes them from 55.0 MB to 26.6 MB, **a 51.6% cut**. Corpus-wide at
1600px the shared image set went 442 MB → 299 MB, a 32% cut.

The standout is `AEROFOX-H7_pinout.png` at **9449×9449**, 89 megapixels, 7.93 MB.
At 2000px it is 0.91 MB and every pin label is still legible at 1:1. That one
file gives back 7 MB, which is 5% of the entire lossless PNG PR.

**Do this by hand, not by rule.** Unlike the lossless pass, resizing cannot fail
safe. Sphinx links each thumbnail to the full-size file, so a cap silently
removes the zoomed view, and for genuine line-art diagrams that zoom is the
point. Someone who knows the hardware should pick a cap per file. Nineteen files
is an afternoon.

`scripts/build_offline_artifacts.py` already has
`ARDUPILOT_OFFLINE_MAX_IMAGE_DIM` doing this for the offline archives only, off
by default, if you want the mechanism.

## 4. Lossless JPEG optimisation

Untried. JPEG has a genuine lossless win: re-optimising Huffman tables and
dropping EXIF, thumbnails and colour profiles, typically 5-10%, with the image
data untouched. Across 287 MB distinct that is maybe 15-25 MB.

Pillow cannot do this; it re-encodes. It needs `jpegtran -optimize -copy none`
or `mozjpeg`, which is a binary dependency on the build server, a bigger ask
than Pillow. **Measure it before proposing it.**

## 5. WebP lossless — measured and rejected

Another **20.4%** beyond the current PNG pass, pixel-identical, zero encode
failures across 459 sampled images.

Rejected because it renames files. Every `<img src>` in the built HTML would
need rewriting, and the failure mode changes from "saved nothing" to "broken
images". ArduPilot's wiki images are linked directly from the forum, from
Discord and from other sites, so that breakage would be silent and invisible to
us. Not worth 20% of one asset class.

## Not image work, but bigger than all of it

`update.sh:147` runs:

```
python3 update.py --destdir /var/sites/wiki/web --clean --paramversioning --parallel 1 --enablebackups --verbose
```

`--clean` (not `--fast`) makes `build_one()` `shutil.rmtree()` every wiki's
build directory, so the doctree cache is discarded and all 3,958 pages rebuild
from scratch every run. `--parallel 1` builds the wikis one at a time. The
incremental machinery works and is simply never used.

Both are probably deliberate: Sphinx across eleven wikis wants several GB of RAM
and the build server may not have it. But **this is minutes per build against
megabytes per reader**, and it needs no code, only measurement. Worth profiling
a production-shaped build before spending more time on images.

## Also found, unrelated to size

**37 broken image links across 17 pages.** The RST uses
`:target: ../../images/foo.png`, pointing into the source tree, which is never
deployed. The `<img src>` is correct so the image displays, but clicking it for
full size 404s. 15 of the references are `src` rather than `href`, meaning those
images do not display at all. The identical lines exist in `upstream/master`, so
this is pre-existing and live on ardupilot.org today.
