# Preplot

Preplot is a pre-install AV site survey app. It runs entirely in the browser, works offline,
stores everything on your phone. No accounts or backend; data leaves the device
only when you explicitly export or share it.

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
3. Upload **all eight files** from this bundle:
   - `index.html`
   - `photo-store.js`
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
- **Export data** downloads a versioned JSON backup. **Import** validates and
  upgrades older exports before applying them. **Show raw data** is the fallback
  if a download is ever blocked.
- Importing over work and clearing a survey create a recoverable snapshot.
  **Restore backup** appears whenever one is available.
- Tap any photo thumbnail to inspect the full stored survey image without the
  thumbnail crop, then move through the other photos in that section.
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
- At the end of a visit, open **Data & storage** and choose
  **Prepare photo package**. The app builds one ZIP containing every stored
  survey photo under its handoff filename, compact survey JSON that references
  those packaged photo files, and an Excel-friendly photo manifest.
  **Share package…** opens the device share
  sheet for Google Drive; **Download package instead** is always available.
  The app cannot verify either destination, so it tells you to confirm the file
  in Drive or Files and never claims that it was uploaded or saved.
- **PDF** builds a print report — use *Share → Print → pinch out → Save as PDF*.

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
var CACHE = "avl-survey-v16";  // bump this for every runtime change
```

The page checks `sw.js` without using the browser's HTTP cache. When a changed
worker finishes installing, the open app keeps using its current version and
shows an **Update / Later** notice. **Update** activates the waiting worker and
reloads the page; **Later** leaves the current survey session alone.

The original v1 app did not contain the update-notice code. The first upgrade
from v1 to v2 may therefore require fully closing and reopening the installed
app once. Updates after v2 use the in-app notice.

The PWA still has no build step. `package.json`, `tests/`, and `.github/` support
automated testing only and are not required when uploading the eight runtime
files from an iPhone.

## Tests

The browser suites start the app on localhost and verify:

- legacy data migrates to schema v3 and saves in a versioned envelope without
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
  persist only verified descriptors in schema v3; failed storage falls back to
  inline survey photos without interrupting capture
- the derived photo manifest includes every photo exactly once in stable site,
  room, section, and bucket order; filenames use global references, visible room
  positions, frozen section slugs, and the source image MIME
- the prepared photo ZIP extracts with an independent system reader, preserves
  every source byte and manifest filename in canonical order, carries compact
  survey JSON without a second base64 copy, and writes RFC-compatible CSV with
  a UTF-8 BOM
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
or deleting the home screen app, wipes it. **Export after every site visit.**

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
survive clearing browser data, so exports remain required after every visit.

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
