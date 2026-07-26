# AVL Site Survey — install guide

A pre-install AV site survey app. Runs entirely in the browser, works offline,
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
- After capture, the new survey copy opens immediately. Tap **Save photo…** to
  open the device share sheet, then choose **Save Image** on iPhone or
  **Photos / Gallery** on Android. The browser cannot verify which destination
  you chose, so the app never claims that the image was saved.
- The saved/shareable survey copy is the same compressed image held by the app:
  JPEG, maximum 900px on its longest edge, with camera metadata removed. If file
  sharing is unavailable or fails, **Download image** appears as a fallback.
- A new capture is persisted before its viewer opens. If survey storage rejects
  it, the viewer says so while the in-memory image is still available to share,
  instead of hiding the failure behind a generic toast.
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
var CACHE = "avl-survey-v9";   // bump this for every runtime change
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

- legacy data migrates to schema v2 and saves in a versioned envelope
- damaged, foreign, and newer-schema imports cannot replace valid work
- import and clear snapshots can be restored, and restore is itself undoable
- unreadable stored data is salvaged rather than silently discarded
- storage warnings measure the localStorage limit that photos actually consume
- photo controls remain valid siblings, only one delete can be armed at a time,
  and a second tap removes exactly the selected image
- the full-screen viewer uses the selected stored image uncropped, stays inside
  its section, cancels armed deletion, and restores scroll position and focus
- Save photo passes the actual byte-exact `File` to `canShare()` and `share()`
  within the trusted tap, blocks overlapping calls, treats cancellation calmly,
  never mutates survey state, and never reports an unverifiable save
- unsupported or failed file sharing exposes a byte-exact download fallback,
  while successful capture opens the stored survey copy and its manual save action
- capture persistence completes before the viewer opens; a simulated
  storage-full failure remains visible and shareable for the current session
- new captures are mirrored byte-exactly to IndexedDB under unique stable IDs,
  while schema v2 stays authoritative if the new store is unavailable
- the derived photo manifest includes every photo exactly once in stable site,
  room, section, and bucket order; filenames use global references, visible room
  positions, frozen section slugs, and the source image MIME
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

### Required phone checks before releasing photo save

Browser automation cannot inspect the native share sheet or the Photos/Gallery
destination. Keep photo save in draft until all of these pass on installed PWAs:

- iPhone: capture, tap **Save photo…**, choose **Save Image**, then verify the
  photo, dimensions, and portrait/landscape orientation in Photos
- Android: capture, tap **Save photo…**, choose Google Photos or the device
  Gallery, then verify the photo, dimensions, and portrait/landscape orientation
- cancel on each platform and retry without reloading the app
- repeat in airplane mode, with repeated captures, and from the viewer after
  fully closing and reopening the app

GitHub Actions runs the same test for pull requests and pushes to `main`.

## Data safety

Everything lives in your phone's browser storage. Clearing Safari website data,
or deleting the home screen app, wipes it. **Export after every site visit.**

The app stores schema-versioned data and keeps a pre-destructive backup before
import or clear. Individual photo deletion requires two taps but is not
recoverable. Unreadable stored data is retained separately for recovery. The
Data & storage card measures usage against the approximately 5 MB localStorage
ceiling, warns at 60%, and escalates at 85%. This makes the current photo limit
visible.

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
