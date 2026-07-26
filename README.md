# AVL Site Survey — install guide

A pre-install AV site survey app. Runs entirely in the browser, works offline,
stores everything on your phone. No accounts, no backend, no data leaves the device.

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
3. Upload **all seven files** from this bundle:
   - `index.html`
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
var CACHE = "avl-survey-v2";   // was v1
```

The page checks `sw.js` without using the browser's HTTP cache. When a changed
worker finishes installing, the open app keeps using its current version and
shows an **Update / Later** notice. **Update** activates the waiting worker and
reloads the page; **Later** leaves the current survey session alone.

The original v1 app did not contain the update-notice code. The first upgrade
from v1 to v2 may therefore require fully closing and reopening the installed
app once. Updates after v2 use the in-app notice.

The PWA still has no build step. `package.json`, `tests/`, and `.github/` support
automated testing only and are not required when uploading the seven runtime
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

GitHub Actions runs the same test for pull requests and pushes to `main`.

## Data safety

Everything lives in your phone's browser storage. Clearing Safari website data,
or deleting the home screen app, wipes it. **Export after every site visit.**

The app stores schema-versioned data and keeps a pre-destructive backup before
import or clear. Individual photo deletion requires two taps but is not
recoverable. Unreadable stored data is retained separately for recovery. The
Data & storage card measures usage against the approximately 5 MB localStorage
ceiling, warns at 60%, and escalates at 85%. This makes the current photo limit
visible; moving photos to IndexedDB is still the next storage task.
