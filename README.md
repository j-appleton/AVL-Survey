# PrePlot

PrePlot is a pre-install AV site survey app. It runs entirely in the browser, works offline,
stores everything on your phone. No accounts or backend; data leaves the device
only when you explicitly prepare and share the complete package.

## Why it needs hosting

iOS will not run JavaScript in a local `.html` file opened from Files, Mail, or an
in-app preview — it renders the page but disables scripts, so every tap does nothing.
Serving it over `https://` fixes that and unlocks offline install.

GitHub Pages is free and takes about five minutes.

---

## 1. Put the files on GitHub Pages

1. Go to **github.com** → **New repository**.
   - Name it something like `avl-survey`
   - Set it to **Public** (Pages requires this on free accounts)
   - Tick **Add a README file**, then **Create repository**
2. In the new repo click **Add file** → **Upload files**.
3. Upload **all ten files** from this bundle:
   - `index.html`
   - `photo-store.js`
   - `photo-captions.js`
   - `compose.js`
   - `sw.js`
   - `manifest.webmanifest`
   - `icon-192.png`
   - `icon-512.png`
   - `apple-touch-icon.png`
   - `favicon.png`

   Keep them at the top level — do not put them in a folder.
4. Click **Commit changes**.
5. Go to **Settings** → **Pages** (left sidebar).
   - Under *Source*, choose **Deploy from a branch**
   - Branch: **main**, folder: **/ (root)** → **Save**
6. Wait 1–2 minutes. The page will show your URL:

   `https://<your-username>.github.io/avl-survey/`

---

## 2. Install it on your iPhone

1. Open that URL in **Safari** (it must be Safari — Chrome on iOS can't install web apps).
2. Tap the **Share** button (square with an arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Name it and tap **Add**.

You now have an app icon. Opening it runs full-screen with no browser chrome, and
it works with no signal — the service worker caches everything on first load.

**Load it once on wifi before your first site visit** so the cache is populated.

---

## 3. Using it

- **Nothing is required.** Every section past "Room" has a *skip* button.
- The **core** counter in the header tracks the small subset worth chasing before
  you leave site. Everything else is optional.
- **+ Room** adds a space; **Duplicate** clones one for near-identical rooms.
- **Restore from package** accepts a complete PrePlot ZIP package or an older
  JSON backup, validates it before touching the current survey, and upgrades
  older data when needed.
- Importing over work and clearing a survey create a recoverable snapshot.
  **Restore backup** appears whenever one is available.
- Photos, capture controls, and recovery notices live in the dedicated
  **Photos** tab. Every room section stays visible there as a direct capture
  checklist, including empty sections; there is no destination picker to hide
  the required shot list. Tap any thumbnail to inspect the full stored survey
  image without the thumbnail crop, then move through the other photos in that
  section. On a laptop, drag the handle on a photo to reorder it within that
  section; the package, PDF, and HTML report follow the same order.
- The top of the Photos tab makes the report cover an explicit decision. Choose
  a photo there or from the full-screen viewer; without one, the PDF uses a
  deliberate plain navy cover rather than silently taking the first photo.
- **Compose** is the laptop-friendly handoff workspace: refine captions, choose
  the cover, write a short executive summary, exclude weak photos from the PDF
  and HTML report without deleting them from the archive, and preview both real
  report files before rebuilding the package. PDF previews open in the device's
  native viewer; HTML previews stay in the app with a reliable close path.
- After capture, the app stays in the survey and reports the batch once. Tap any
  thumbnail when you want the full viewer, then tap **Save photo…** to open the
  device share sheet and choose **Save Image** on iPhone or **Photos / Gallery**
  on Android. The browser cannot verify which destination you chose, so the app
  never claims that the image was saved.
- The saved/shareable survey copy is the same compressed image held by the app:
  JPEG, maximum 900px on its longest edge, with camera metadata removed. If file
  sharing is unavailable or fails, **Download image** appears as a fallback.
- New captures are processed sequentially in selection order and persisted
  before they are reported as added. If survey storage rejects a batch, a
  persistent notice stays above that section's thumbnails with a manual Save
  action for every in-memory image.
- At the end of a visit, tap **Package** and choose
  **Prepare complete package**. The app builds one ZIP containing every stored
  survey photo under its handoff filename, compact survey JSON that references
  those packaged photo files, an Excel-friendly photo manifest, a plain-text
  CRM note containing every survey field, a designed
  site-visit PDF, and a searchable interactive HTML report with every included
  full-resolution photo embedded directly in the file. The separate `photos`
  folder still carries every original, including photos excluded from reports.
  The complete ZIP can be imported back into PrePlot as the survey backup.
  **Share package…** opens the device share
  sheet for Google Drive; **Download package instead** is always available.
  The app cannot verify either destination, so it tells you to confirm the file
  in Drive or Files and never claims that it was uploaded or saved. This ZIP is
  the app's only outward report or backup handoff.
  Rebuilding currently creates another ZIP rather than replacing an earlier
  Drive upload, so confirm which copy is current.

### Ambient light

Take lux readings at the display wall, mid-seating, and the rear/window wall.
A phone light-meter app is fine. If you have no meter, pick the closest preset.

The app then computes:

- **Direct-view:** minimum panel nits, based on illuminance at the display wall
  (that's what causes washout, not the brightest corner of the room)
- **Projection:** target footLamberts and minimum ANSI lumens from diagonal and
  screen gain, including 1.4× headroom for lamp ageing and optical loss
- A hard warning above 300 lux that projection is the wrong call
- A daylight-migration warning when the rear reading dwarfs the display wall —
  your 10am number won't survive 3pm
- A **DISCAS sizing check** against the furthest seat, flagging undersized displays

---

## Updating it later

Edit the app files, then bump the cache version in `sw.js`:

```js
var CACHE = "avl-survey-v28";  // bump this for every runtime change
```

The page checks `sw.js` without using the browser's HTTP cache. When a changed
worker finishes installing, the open app keeps using its current version and
shows an **Update / Later** notice. **Update** activates the waiting worker and
reloads the page; **Later** leaves the current survey session alone.

The original v1 app did not contain the update-notice code. The first upgrade
from v1 to v2 may therefore require fully closing and reopening the installed
app once. Updates after v2 use the in-app notice.

The PWA still has no build step. `package.json`, `tests/`, and `.github/` support
automated testing only and are not required when uploading the ten runtime
files from an iPhone.

## Tests

The browser suites start the app on localhost and verify:

- legacy data migrates to schema v5 and saves in a versioned envelope without
  replacing its existing metadata
- damaged, foreign, and newer-schema imports cannot replace valid work
- import and clear snapshots can be restored, and restore is itself undoable
- unreadable stored data is salvaged rather than silently discarded
- storage warnings measure the localStorage limit that photos actually consume
- photo controls remain valid siblings, only one delete can be armed at a time,
  and a second tap removes exactly the selected image
- the full-screen viewer uses the selected stored image uncropped, stays inside
  its section, cancels armed deletion, and restores scroll position and focus;
  thumbnails hydrate from Blob URLs in place without re-rendering the survey
- Save photo passes the actual byte-exact `File` to `canShare()` and `share()`
  within the trusted tap only after the current photo is resident, blocks
  overlapping calls, treats cancellation calmly, never mutates survey state,
  and never reports an unverifiable save
- unsupported or failed file sharing exposes a byte-exact download fallback,
  while successful capture stays in the survey and leaves manual sharing on the thumbnail
- capture batches preserve selection order, render once, report once, and never
  open the viewer automatically; a simulated storage-full failure remains
  persistently visible and shareable for the current session
- new captures store byte-exact photos in IndexedDB under unique stable IDs and
  persist only verified descriptors; failed storage falls back to
  inline survey photos without interrupting capture
- the derived photo manifest includes every photo exactly once in stable site,
  room, section, and bucket order; filenames use global references, visible room
  positions, frozen section slugs, and the source image MIME
- the prepared photo ZIP extracts with an independent system reader, preserves
  every source byte and manifest filename in canonical order, carries compact
  survey JSON without a second base64 copy, and writes RFC-compatible CSV with
  a UTF-8 BOM
- the interactive HTML report embeds its included full-resolution photos,
  escapes survey content, makes no external requests, follows PDF/manifest
  photo order, and opens the exact source shown on each card
- package sharing passes the exact prepared ZIP to `canShare()` and `share()`
  inside the trusted tap, blocks overlaps, permits cancellation and retry, and
  never mutates the survey or makes an unverifiable success claim
- exact package staleness checks cover survey identity, room names, manifest
  ordering, and same-length photo replacements before both share and download;
  state changes during preparation discard the package
- storage retention reports whether the browser actually granted persistence,
  without changing the localStorage meter or treating the result as a backup
- the ambient-light and DISCAS calculations retain their domain thresholds
- the installed app reloads offline with survey data intact
- a new service worker waits for **Update**, **Later** preserves the open session,
  and old caches are removed only after explicit activation

Run it with:

```sh
npm ci
npx playwright install chromium
npm test
```

### Required phone checks

Browser automation cannot inspect the native share sheet or the Photos/Gallery
destination. Keep photo save in draft until all of these pass on installed PWAs:

- iPhone: capture, tap **Save photo…**, choose **Save Image**, then verify the
  photo, dimensions, and portrait/landscape orientation in Photos
- Android: capture, tap **Save photo…**, choose Google Photos or the device
  Gallery, then verify the photo, dimensions, and portrait/landscape orientation
- cancel on each platform and retry without reloading the app
- repeat in airplane mode, with repeated captures, and from the viewer after
  fully closing and reopening the app

For a photo package release, test 60, 75, and 100 real photos on the installed
iPhone PWA. Record preparation time and ZIP size, share to Google Drive, download
to Files, and confirm the destination sizes match the app. Extract the archive
on a computer and check the entry count, order, filenames, and first/middle/last
photo bytes. Also cancel and retry, prepare offline, and prepare again after
fully closing the PWA. Stop if any photo is missing or duplicated, any size
differs, cancellation disables retry, or the app claims an upload succeeded.

Android package sharing is supported on a best-effort basis but remains
unverified because the maintainer does not have an Android test device.

GitHub Actions runs the same test for pull requests and pushes to `main`.

## Data safety

Everything lives in your phone's browser storage. Clearing Safari website data,
or deleting the home screen app, wipes it. **Prepare and confirm the complete
package after every site visit.**

The app stores schema-versioned data and keeps a pre-destructive backup before
import or clear. Individual photo deletion requires two taps but is not
recoverable. Unreadable stored data is retained separately for recovery. The
Data & storage card measures survey-state and inline-fallback usage against the
approximately 5 MB localStorage ceiling, warns at 60%, and escalates at 85%.
Authoritative photo bytes are stored separately in IndexedDB.

Version 1.5 begins the photo-storage transition by also writing each newly
captured, compressed photo to IndexedDB with a stable ID. Schema v2, exports,
backups, the viewer, sharing, printing, deletion, and the storage meter still
use the localStorage data URL. The duplicate write is deliberately temporary:
it proves the new store on real surveys before any read path or migration
depends on it.

The Data & storage card also reports whether the browser granted persistent
storage. A grant reduces automatic eviction risk but is not a backup and cannot
survive clearing browser data, so a complete package remains required after every visit.

Version 1.6 establishes the pure, in-memory photo manifest that future batch
sharing and PDF captions will use. It does not yet add a batch-share control or
upload anything; the existing one-photo-at-a-time share action is unchanged.

Version 1.7 uses that manifest to prepare one trustworthy, byte-preserving ZIP
for Drive handoff. The archive is built only when requested and held in memory;
any change to survey identity, room names, photo order, or photo content makes
it stale and disables both share and download until it is prepared again.

Version 1.8 adds the photo read seam needed for the storage transition. Persisted
survey data remains schema v2 and localStorage remains authoritative, but runtime
thumbnails, the viewer, printing, single-photo sharing, and package preparation
now consume resident Blobs through one accessor. Object URLs are retired when
photos leave the survey and on page exit, while an open viewer keeps its current
photo alive. Save photo stays disabled until the exact current File is ready, so
the trusted share tap performs no storage read or decode.

Version 1.9 makes every photo-reading surface understand either today’s inline
image or a stable device-storage descriptor. It adds a keys-only integrity
check, explicit missing-photo states, true byte counts in the manifest, compact
descriptor backups, and portable schema-v3 exports that re-inline every image.
Capture remains unchanged and schema v2 stays authoritative, so this release
creates no descriptors during normal use and can be rolled back without a data
migration. The next release is the deliberate capture-and-schema flip.

Version 1.9.1 removes capture-time viewer interruption and processes multi-photo
selections sequentially, preserving the order that flows into the manifest, ZIP
and PDF. A capture batch renders and reports once. If local survey persistence
fails, an undismissable section notice keeps every in-memory photo reachable
through its manual Save action. Schema v2 and the existing dual-write storage
authority remain unchanged. If the temporary device-storage mirror fails, the
Data & storage panel keeps the export warning visible instead of letting the
batch summary overwrite it.

Version 1.10 makes device storage authoritative for new captures and moves the
survey envelope to schema v3. A descriptor is assembled only from the record
returned by IndexedDB, read back before it can persist, and replaced by an inline
fallback if either write or verification fails. Portable imports assign fresh
IDs and fall back as one whole file rather than leaving mixed authority. Field
edits made during the short verification window are included in the batch-end
save, and unreadable prior data keeps a persistent salvage warning.

Version 1.11 gives every photo-package entry one named survey root. Full photo
bytes live under `photos/`, while the manifest and compact archive-only survey
record live under `data/`. Photo paths inside the JSON are explicitly relative
to that archive root, so moving the JSON itself cannot silently change what its
cross-references mean.

Version 1.12 adds an always-reachable Photos view in the sticky header. It is a
second view of the canonical photo manifest, not a second photo model: order,
capture, recovery, deletion, the full-screen viewer, ZIP names, and later PDF
references all continue to use the same buckets and coordinates. The selected
view is deliberately session-only and never enters exports or backups.

Version 1.13 replaces the browser print sheet with a real in-app PDF writer.
The report uses portrait cover and room pages, landscape photographic-record
sheets, explicit measurement qualifiers, and filenames matching the full photo
copies in the ZIP. Report renditions are 600px JPEGs used only inside the PDF;
the archive’s `photos/` files remain byte-identical to the stored survey images.

Version 1.14 adds an interactive HTML report beside the PDF. It uses the same
report model, remains searchable, and originally loaded full-size images from
the adjacent `photos/` folder without network requests.

Version 1.15 makes the complete ZIP a restorable artifact. The importer validates
the archive and every declared photo before changing survey state, assigns fresh
device-storage IDs, and maps the selected cover by its handoff filename.

Version 1.16 makes the package the only outward handoff, moves all photo work to
the Photos tab, and requires an explicit report-cover choice. Each package also
contains a CRLF, UTF-8 plain-text CRM note with every canonical field, including
blank answers, while skipped sections remain visibly marked not applicable.

Version 1.17 adds optional one-line photo captions in the Photos tab. Captions
are keyed to stable stored-photo IDs, survive complete-package export and import
when fresh IDs are assigned, and appear consistently in the PDF, HTML report,
photo manifest, and CRM note. Legacy inline photos remain deliberately
uncaptioned until they are migrated to device storage.

Version 1.18 adds Compose as the post-visit workspace. Schema v5 stores a short
executive summary and stable-ID report exclusions; exclusions never renumber the
manifest or remove originals from the archive. PDF and HTML previews use the
real report builders, package imports remap exclusions to fresh photo IDs, and
orphan caption/exclusion keys are repaired instead of blocking the survey.

Version 1.18.1 moves PDF preview into the device's native PDF viewer instead of
an iOS-unfriendly embedded frame, locks and restores the app around HTML
preview, and embeds included full-resolution photos directly in the HTML report
so Files and Drive previews do not depend on sibling-file access.

Version 1.18.2 keeps the HTML preview title and Close control below the iPhone
status area, clear of every screen-edge safe area, with a full-size mobile tap
target.

Version 1.19 adds desktop photo reordering within each capture section and keeps
the Add Photo control on its own row below thumbnails and captions.

Version 1.19.1 resets PDF character spacing after letterspaced headings so
wrapped notes render at the same width used by the layout engine.

Version 1.20 places the executive summary at the top of Visit overview and
flows field-note cards beneath it instead of reserving an otherwise empty page.
