# joinfs-gpx2jfs-converter-webcomponent

A self-contained web component, `<joinfs-gpx-to-jfs>`, that converts a **GPX tracklog into a JoinFS recording
(`.jfs`)** in the browser, so it can be replayed in the JoinFS Recorder. Nothing is uploaded; there is no server
code, build step or runtime dependency. It also derives gear, flaps and lights from the track.

```html
<joinfs-gpx-to-jfs></joinfs-gpx-to-jfs>
<script src="joinfs-gpx-to-jfs.js"></script>
```

- Drop zone and file picker, a clear download button, progress bar and cancel.
- Aircraft settings (ICAO type, callsign, model title, ...) with presets via attributes or URL parameters, remembered
  in the browser.
- Material Design look, responsive (320 px and up), light and dark theme following the browser setting.
- Lazy-loaded language files (English built in, German included), English as the fallback.
- Tested unit-wise, in jsdom, in a real Chromium, and against an independent Python reference writer.

This is an independent tool and not affiliated with JoinFS. See [License](#license).

## Screenshots

Before a file is loaded, with all input fields and with everything preset (no input fields), in light and dark theme:

![Initial state: with and without input fields, light and dark](docs/screenshots/overview-initial.png)

After a conversion, with the download button:

![After conversion: with and without input fields, light and dark](docs/screenshots/overview-converted.png)

The single images are in `docs/screenshots/`; `npm run screenshots` regenerates them.

## Demo

Serve the repository with any static web server and open `demo/index.html`:

```sh
npx serve .            # or: python3 -m http.server
```

`demo/sample-track.gpx` is a synthetic flight you can drop on the page. Language files are fetched with
`fetch()`, so the demo needs http(s); opened straight from disk it works but stays English.

## Use it

Copy the files from `src/` into one folder of your site (the language files must sit next to the script):

| File | Purpose |
|---|---|
| `joinfs-gpx-to-jfs.js` | Component, converter and built-in English texts |
| `joinfs-gpx-to-jfs.de.json` | German texts, lazy-loaded when the browser prefers German |
| `joinfs-gpx-to-jfs.en.json` | Template for translators (identical to the built-in English texts) |

Then add the script and the tag as shown above. The user flow is:

1. Drop a GPX file on the dashed area or click **Choose GPX file**.
2. Check the aircraft settings and press **Convert** (skipped when everything is preset, see below).
3. Press the big **Download …jfs** button, then in the JoinFS Recorder choose *File | Open Recording…*.

The GPX needs timestamps. Heading, pitch and bank are derived from the track (see
[What the converter does](#what-the-converter-does)).

## Attributes and URL parameters

| Setting | Attribute | URL parameter | Values |
|---|---|---|---|
| ICAO type designator | `icao-type` | `icao` (or `icao-type`) | 2–4 letters/digits, default `C172` |
| Callsign | `callsign` | `callsign` | up to 16 chars, default `ASGX` |
| Model title | `model` | `model` | up to 128 chars, default `Cessna 172 Wheels` |
| Livery | `livery` | `livery` | up to 128 chars, empty by default; MSFS 2024 builds only, the field is hidden for the others |
| Pilot name | `nickname` | `nickname` | up to 32 chars (empty is allowed) |
| JoinFS build | `build` | `build` | `fs2024` (default) or `other` |

Two more settings exist but have **no input field**; they are taken from the attribute or URL parameter, or stay at
their default:

| Setting | Attribute | URL parameter | Values |
|---|---|---|---|
| Aircraft systems | `systems` | `systems` | `full` (default) or `off`, see [Gear, flaps and lights](#gear-flaps-and-lights) |
| Type role | `typerole` | `typerole` | `unknown` (default), `singleprop`, `twinprop`, `airliner`, `rotorcraft`, `glider`, `fighter`, `bomber`, `fourprop`, `airship`, `balloon` |

**Leave the type role alone unless you know it is right.** JoinFS does not derive it from the ICAO type designator
when it replays a recording: it reads the byte from the file and feeds it straight into model matching, which awards
+15 for a matching type role but **−240 for a mismatch** when the ICAO type is not an exact hit — enough to push an
otherwise good substitute below the match threshold. `unknown` (0) makes JoinFS skip the comparison altogether and
match on the ICAO type designator instead, from which it derives the Doc8643 class code and wake-turbulence category
itself. A wrong value is worse than no value.

- A **valid value presets the setting and hides its input field.** A short read-only line shows the preset
  aircraft values. Invalid values are ignored (the field stays visible).
- If **no field is left visible**, the Convert button is hidden and the file is converted as soon as it is loaded
  (`auto-convert` forces this in general).
- URL parameters win over attributes; `no-url-params` switches them off.
- `editable` keeps all fields visible and uses attribute/URL values only as **defaults**.
- `flaps-takeoff` and `flaps-landing` (0–1, default `0.15` and `1`) set the flap handle position for takeoff and
  landing. They are attributes only, without an input field.
- The three aircraft defaults are the assumed standard MSFS 2024 Cessna 172 values; please check them against your
  simulator.
- **Model title and livery are what pick the aircraft.** JoinFS first looks for an installed model whose title
  matches exactly -- on the MSFS 2024 build, title *and* livery both have to match -- and replays that one. Only
  when nothing matches does it score the remaining attributes and substitute a similar aircraft, and there the
  livery is the weakest signal of all (one point per shared word). The livery string exists in the MSFS 2024 file
  layout only, so the Livery field is hidden whenever the JoinFS build is set to anything else; the value is kept,
  so switching back brings it up again.

Example: `demo/index.html?icao=C172&callsign=ASGX&model=Cessna%20172%20Wheels`

### Remembered settings

Visible fields are stored in `localStorage` (key `joinfs-gpx-to-jfs:v1`, change with `storage-key`), so a user who
always flies the same aircraft does not have to retype anything. The defaults stay visible as placeholders;
**Reset to defaults** clears the stored values. Preset (hidden) values are never stored. If `localStorage` is
blocked, everything works but nothing is remembered.

## Languages

English is built in. Other languages are **lazy-loaded** as `joinfs-gpx-to-jfs.<locale>.json` from the folder the
script was loaded from (override with `locale-base="/path/"`):

1. The browser's preferred languages (`navigator.languages`) are tried in order. For `de-AT` the files
   `joinfs-gpx-to-jfs.de-AT.json`, then `joinfs-gpx-to-jfs.de.json` are requested.
2. The first file that exists is used. If English comes first in the preference list, or none of the preferred
   languages has a file, the built-in English texts are used.
3. Missing keys in a translation fall back to English individually, so partial translations are fine.

`lang="de"` on the element or `?lang=de` in the URL forces a language.

**Add a language:** copy `joinfs-gpx-to-jfs.en.json` to `joinfs-gpx-to-jfs.<locale>.json` (e.g.
`joinfs-gpx-to-jfs.fr.json`), translate the values and keep the `{placeholders}` unchanged. No code changes are
needed; `npm test` checks that a translation is complete and has matching placeholders.

## Styling: responsive, light and dark

- **Responsive:** the component fills the width of its container (up to 34 rem, change with `--gj-max-width`). It
  stays usable down to 320 px, long file names wrap instead of overflowing, and touch screens get 48 px buttons.
- **Light/dark:** it follows the browser/OS setting (`prefers-color-scheme`), including the native select
  dropdowns. Force a scheme with `theme="light"` or `theme="dark"` (default `auto`), for example to follow a theme
  switch on your own page.
- **Colours:** override with CSS variables on the element: `--gj-accent`, `--gj-on-accent`, `--gj-bg`, `--gj-fg`,
  `--gj-muted`, `--gj-outline`, `--gj-border`, `--gj-placeholder`, `--gj-error`, `--gj-container`,
  `--gj-on-container`, `--gj-error-container`, `--gj-on-error-container`. A variable applies to both schemes, so set
  it inside a `prefers-color-scheme` rule if you want different values per scheme.
- The card and drop zone are exposed as `::part(box)` and `::part(dropzone)`.

## Gear, flaps and lights

Unless `systems` is `off`, the converter adds gear, flaps and lights to the recording. They are derived from the
track (thresholds are options of `Gpx2Jfs.convert`; ground speed is used for all speeds):

| | Rule |
|---|---|
| Flaps, takeoff | 15 % from the start. They retract when the aircraft reaches start elevation + 200 ft if the speed is below 140 kt at that moment, otherwise at + 1000 ft. |
| Flaps, landing | 100 % as soon as the speed is at most touchdown speed + 20 kt **and** the distance to touchdown (along the track) is at most 3 nm below 100 kt or 7 nm at 100 kt and above, while airborne. After touchdown they go up again below 30 kt. |
| Gear | Up together with the takeoff flaps, down 1 nm (along the track) before the flaps-full point. The handle is written for fixed-gear aircraft too; the simulator is expected to ignore it. |
| Nav, beacon | On for the whole track. |
| Strobe | On from the start of the takeoff roll until the runway is vacated (below 30 kt after touchdown). |
| Landing light | On at 4000 ft above the ground reference or lower, off again above 4300 ft (300 ft hysteresis), between the start of the takeoff roll and vacating the runway. The reference moves linearly from the start to the end elevation. |
| Taxi light | On from the first movement until the takeoff roll starts, and again after vacating the runway. |

Every event is found once over the whole track and then latched, so speed noise around a threshold cannot make a
setting flip back and forth. Only the ground contact is debounced (5 s). The rules assume one takeoff and one final
landing; touch-and-go patterns in between are not treated separately. Touchdown is detected 8 m above the ground,
so distance-based triggers fire about 0.2 nm early.

The simulator maps the flap value to the nearest detent, so a value like 15 % may land on flaps up on an aircraft
with few detents. Adjust `flaps-takeoff` for your aircraft.

How it is stored: `GEAR HANDLE POSITION`, `FLAPS HANDLE PERCENT`, `LIGHT STATES` (the bit mask that drives the
lights, plus its per-bit mirrors) and `LIGHT STROBE` as timestamped variable frames. The variable IDs are hashes of
the lower-cased SimVar names, as in the JoinFS source. The state is written at every change, at the start and then
every 5 s, because the replay aircraft may only appear a moment after playback starts. This adds about 80 KB per
hour of flight.

## What the converter does

A GPX only contains position, altitude and time, so:

- The 1 Hz track is smoothed with a cubic spline and written at 5 Hz (API option `hz`; JoinFS interpolates
  between frames by their timestamps, so the rate only affects smoothness and file size). Long standstills in the
  track are held in place, other long gaps are bridged in a straight line.
- **Heading** = course over ground, **pitch** = flight-path angle plus a 2° trim, **bank** = coordinated-turn bank
  from the heading rate (clamped to ±45°). Sign conventions follow JoinFS: positive pitch = nose down, positive bank
  = left wing down.
- **Ground** = within 8 m of the start/end elevation and below 90 kt.
- Not recorded: engines and anything else besides gear, flaps and lights.

### The recording format

Little-endian, written like a .NET `BinaryWriter`; units are radians, metres and m/s.

```
int16   version                       21005 (21003 = without ICAO strings, 21008 = with static CG field)
int32   aircraft count                1
  bool    plane
  string  callsign, nickname, model   7-bit length prefix + UTF-8
  byte    type role                   0 unknown, 1 single prop ... 10 balloon
  int32   frame count
    frame: byte type, double time (s since start), payload
      1  aircraft position: lat, lon, alt (doubles); pitch, bank, heading; velocity, angular velocity,
         acceleration (3 floats each); rudder, elevator, aileron, brakes (int16, value * 16384); elevation (float);
         flags (byte, bit 0 = on ground)
      11 integer variables: uint16 count, then (uint32 id, int32 value)
      12 float variables:   uint16 count, then (uint32 id, float value)
  string  livery                      MSFS 2024 builds only
  string  ICAO type, ICAO airline
int32   object count                  0
```

**The JoinFS build matters:** recordings written by the MSFS 2024 build contain the extra livery string, so a file
made for one layout cannot be read by the other. The `build` setting selects the layout. Version 21005 is the first
that stores the ICAO type. JoinFS documents the format in `docs/recording-protocol.md` of its repository.

## JavaScript API

```js
Gpx2Jfs.convert(gpxText, options)            // -> { data: Uint8Array, info }   (synchronous)
Gpx2Jfs.convertAsync(gpxText, options, { onProgress, signal })   // Web Worker, falls back to the page thread
Gpx2Jfs.DEFAULTS                              // all options with their defaults
Gpx2Jfs.messages.en                           // built-in UI texts
```

Options include `icaoType`, `callsign`, `model`, `nickname`, `typerole`, `hz`, `jfsVersion`, `fs2024`, `systems`,
`flapsTakeoff`, `flapsLanding` and the thresholds listed in `DEFAULTS`. Errors are `Gpx2Jfs.GpxError` with a `code`
(and `params`) that the UI translates.

Events on the element: `converted` (`detail = { info, blob, filename }`) and `locale-loaded`
(`detail = { locale }`).

The heavy part runs in a Web Worker created from a Blob of the same file (progress bar and Cancel button). If a
worker cannot be started (for example a strict CSP without `worker-src blob:`), it falls back to the page thread.

## Development

Requires Node 22.22+ / 24.15+ (jsdom 30); the component itself needs nothing.

```sh
npm install
npm test                 # unit, component (jsdom), locale and reference tests
npm run test:browser     # real-browser tests (optional packages puppeteer-core + @sparticuz/chromium)
npm run test:all
npm run sample           # regenerate demo/sample-track.gpx
npm run screenshots      # regenerate docs/screenshots (needs the optional browser packages)
```

`@sparticuz/chromium` ships a Linux binary only, so on Windows and macOS the browser tests skip and the screenshot
tool fails. Point `CHROME_PATH` at a locally installed Chrome or Edge to run them anyway:

```sh
CHROME_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" npm run test:browser
```

| Suite | Covers |
|---|---|
| `test/converter.test.js` | GPX parsing, file layout for all three layouts, heading/pitch/bank and their signs, gaps, gear/flaps/lights rules (hysteresis, speed + distance rule, gear timing, options), worker path, snapshot hash |
| `test/reference.test.js` | Byte-for-byte comparison with `tools/reference/gpx2jfs.py` (needs Python 3; skipped without it) |
| `test/component.test.js` | Presets, URL parameters, drop zone, download, persistence, type role, aircraft systems, languages (jsdom) |
| `test/locales.test.js` | Every language file is complete and has matching placeholders |
| `test/browser/browser.test.js` | Full flow with the Web Worker, drag and drop, real HTTP locale loading, colour schemes, 320–1280 px layout |

All test data is synthetic (`test/helpers/tracks.js`); no recorded flights are included. The recording layout was
also checked once with the reader from the JoinFS source, and the gear/flaps/lights variable IDs against its
variable lookup; those checks need the JoinFS sources and are not part of the test suite.

**Not yet checked:** Firefox and Safari, and replay in a running simulator, including whether the sim accepts the
gear/flaps/light variables on the replay aircraft. A short recording made in JoinFS with gear, flaps and lights
operated would settle that.

### Layout

```
src/         the component and its language files (ship these)
demo/        demo page and synthetic sample GPX
docs/        screenshots
test/        test suites, helpers (synthetic flights, independent .jfs decoder) and the runner
tools/       Python reference writer, sample GPX generator
```

## License

The web component and everything else in this repository, unless noted otherwise, is licensed under the
[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-nc-sa/4.0/)
(CC BY-NC-SA 4.0); see [LICENSE](LICENSE). In short: you may share and adapt it, you must give appropriate credit,
indicate changes and link the license, you may not use it commercially, and adaptations must be shared under the
same license. This summary is not a substitute for the license text.

Please credit it as: *joinfs-gpx2jfs-converter-webcomponent, CC BY-NC-SA 4.0*, with a link to this repository.

The recording format and the variable-hash function come from JoinFS (MIT License); its notice is in
[NOTICE.md](NOTICE.md). The test-only dependencies keep their own licenses.
