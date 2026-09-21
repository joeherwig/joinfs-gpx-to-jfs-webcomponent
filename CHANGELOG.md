# Changelog

## Unreleased

- The **aircraft type** and **aircraft systems** dropdowns are gone. Both stay available as attributes and URL
  parameters (`typerole`, `systems`), they are simply no longer questions the user is asked.
- The default type role is now `unknown` (byte 0) instead of `singleprop` (1). JoinFS reads the byte from the
  recording verbatim and scores it during model matching (+15 for a match, −240 for a mismatch without an exact ICAO
  type match), so guessing single-engine piston actively hurt every other aircraft. With 0 JoinFS skips the
  comparison and matches on the ICAO type designator instead. **This changes the bytes written**; the converter
  snapshot hash was updated accordingly.
- The real-browser tests and the screenshot tool accept `CHROME_PATH` (a locally installed Chrome/Edge), so they
  run on Windows and macOS instead of skipping - `@sparticuz/chromium` carries a Linux binary only.
- Screenshots regenerated.
- **The aircraft is no longer pinned to the runway through the first metres of the climb, nor put down early on
  landing.** SIM ON GROUND is forwarded to the simulator, which then places the aircraft on the terrain itself and
  disregards the altitude in the recording - and it was being written from `groundAglM`, the deliberately generous
  8 m threshold used to decide which *phase* of the flight a sample belongs to. On a real track that meant the bit
  stayed set until 8.8 m up and 2.8 m/s of climb, so the aircraft sat on the runway for five seconds after
  rotation and was then released with a jump, and on approach it was grabbed at 7.3 m and slammed down. The bit is
  now trimmed back to actual contact with the new `groundContactM` (1 m); the phase threshold is unchanged, so
  nothing else about the detection moves. Liftoff and touchdown are also now detected within a metre of the
  ground rather than eight, which makes the distance-based gear and flap triggers correspondingly more accurate.
- **`ground-clearance` now defaults to unknown (NaN), not 0.** A GPX cannot say how far the recorded aircraft's
  datum sat above its wheels. JoinFS cannot tell a declared 0 from an aircraft that genuinely sits flush, so it
  added the *substitute* model's whole clearance on top of every altitude - which the JoinFS source names as the
  cause of its own "hovers meters above the ground" bug, and which is exactly what it did here.
- **Landing flaps now extend in stages instead of one movement**, each stage triggered by airspeed: 33 % at
  touchdown speed + 40 kt, 67 % at + 30 kt, 100 % at + 20 kt (`flapsLandingSteps`, unchanged
  `flapsLandingVtdMarginKt`), with at least `flapsStageMinS` (20 s) between movements so a quick deceleration
  still looks staged. `flapsLandingSteps: []` restores the single movement.
- **Full flaps and gear come down later.** `flapsLandingNearNm` 3 -> 1.5, so full flaps waits until 1.5 nm from
  touchdown once below 100 kt, and the gear (1 nm ahead of it) follows.
- **Takeoff flaps default 15 % -> 20 %.**
- **The ground reference follows the ground the aircraft is actually on.** It used to be a straight line between
  the first and last altitude of the track, which on a real flight put the written GROUND ALTITUDE several metres
  off at the airfield - AGL read negative on the runway. Each unbroken stretch on the ground now gets its own
  field elevation (a low percentile of its altitudes, so the 8 m detection threshold and single GPS outliers do
  not define it), and the airborne stretch is interpolated between them. JoinFS blends its own terrain reading
  against ours at full weight near the ground, so that error was being heaved into the aircraft's height over the
  first hundred metres of the climb.
- **Replayed aircraft no longer surge fore and aft.** The resampler interpolates through every source point (cubic
  Hermite, Catmull-Rom tangents), so GPS noise is amplified rather than averaged: each tangent is a difference of
  neighbouring points and the spline overshoots between them. A real 1 Hz tracklog came out with its speed swinging
  more than 10 knots at about half the sample rate, and the simulator follows that, because it drives the injected
  aircraft from the velocity in the recording - zero those velocities and the aircraft falls out of the sky.
  `smooth-pos` now defaults to **3 s** (was 1.5), which halves the swing on a typical track.
- **The written velocity is now the exact derivative of the written positions.** It used to be filtered separately
  after being derived from them, so the file declared a speed that disagreed with the rate its own positions
  advanced. It is smooth because the positions it differentiates are, not because of a filter of its own. `smoothS`
  still filters the signals used to *derive* heading, pitch, bank and the gear/flaps/lights rules, which want a
  steady input and need not match the derivative.
- **Position smoothing no longer displaces the start and end of a track.** The moving average clamped its window
  one-sided at the array edges, which for a steadily advancing position is not a smoother but a shift of roughly
  (window / 4) x speed - 37 m at the last frame of a 3 s window at cruise. It now shrinks the window symmetrically,
  fading the smoothing out at the ends instead of biasing them.
- **Pitch and bank no longer snap when the on-ground flag flips.** They faded instantly between level and the
  track-derived attitude, a jump of about 7 degrees in a single frame at rotation and touchdown, and repeatedly if
  the flag chattered near its threshold. New `groundBlendS` option (seconds, default 2) ramps it; worst pitch step
  on the sample track drops from 7.09 to 0.67 degrees.
- **The ground reference no longer steps at the midpoint of the flight.** It switched from the departure elevation
  to the arrival elevation in one frame, putting a step of their difference (1.3 m on the sample track) straight
  into the written GROUND ALTITUDE; it now walks between them.
- The Python reference cross-check is **retired**. The converter has moved on in ways that writer does not
  implement and no option can pin, so the suite is skipped rather than weakened. `tools/reference/gpx2jfs.py`
  stays in the tree as a readable description of the format.
- **Position smoothing** (`smooth-pos`, seconds, default `3`, `0` disables), with `npm run track-noise -- x.gpx`
  to measure a particular track and name the smallest window that gets its speed swing under 2 kt. The right value
  depends on how noisy the GPX is - a clean track needs none, a rough one more than the default - so it is worth
  measuring rather than trusting a default tuned on a fixture.
- **Recordings are now written as file version 21008** (was 21005) and carry STATIC CG TO GROUND, set by the new
  `ground-clearance` setting (metres, default `0`; `none` writes NaN). `0` is the truthful value for what this
  converter produces, and it lets JoinFS run its ground-clearance correction, which seats the spawned model's gear
  on the terrain whatever model the matcher picked. Previously this field was always NaN, which makes JoinFS skip
  that correction. **Needs a JoinFS build that understands version 21008**; the `jfsVersion` API option still
  produces the older layouts.
- The Python reference writer is no longer tracked by the component's defaults. `test/reference.test.js` pins the
  options it implements (no position smoothing, the pre-21008 layouts), so it stays a byte-for-byte cross-check of
  the position maths and file layout while the component moves on.
- A blank numeric attribute (`hz=""`, `smooth-pos=""`, ...) is now ignored rather than read as 0.
- New **altitude offset** setting (`altitude-offset` / `alt-offset` attribute and URL parameter, metres, default 0).
  It shifts every written altitude together with the ground reference, so AGL, on-ground detection and the
  gear/flaps/lights timing are untouched. For GPX files whose elevation datum disagrees with the simulator's terrain,
  which shows up as a replayed aircraft hovering above or sunk into the ground. Unlike JoinFS's own height
  adjustment, a correction in the file also applies in shared cockpit.
- The output **frame rate** is settable again, as the `hz` attribute / URL parameter (1-30, default 5). It has no
  input field: it is a property of the file rather than a question for the pilot. 20 Hz gives four times the frames
  and four times the size of the 5 Hz default, without adding detail the GPX does not contain.
- The callsign hint no longer describes General Aviation only: it now names both shapes, a tail number and an
  airline flight number.
- New **Livery** field (`livery` attribute / URL parameter, empty by default). The MSFS 2024 file layout already had
  the slot but the converter always wrote an empty string, so a liveried aircraft could never hit the exact-match
  tier in JoinFS, which needs title *and* livery. The other builds have no livery string, so there the field is
  hidden and follows the JoinFS build setting as it changes; a hidden-because-inapplicable field also no longer
  keeps the Convert button alive when everything else is preset.
- The model-title hint now says why the field matters: an exactly matching title installed in the **replaying**
  simulator is what makes JoinFS replay that model and livery rather than substituting a similar aircraft.
- Translated texts can mark words for emphasis with `*asterisks*`. They render as `<b>` built from text nodes, never
  through `innerHTML`, so a locale file can add emphasis but cannot inject markup.
- Field labels, borders and hints are dimmed to 80% so the entered value is the most prominent part of a field.
  Focus and error states stay at full strength.

## 0.1.0

First version of the repository.

- `<joinfs-gpx-to-jfs>` custom element and `Gpx2Jfs` API: GPX to JoinFS recording (`.jfs`) in the browser.
- Drop zone and file picker, download button, progress and cancel (Web Worker, with fallback to the page thread).
- Aircraft settings with presets via attributes and URL parameters, remembered in `localStorage`.
- Gear, flaps and lights derived from the track.
- Lazy-loaded language files (English built in, German included), light and dark theme, responsive layout.
- Screenshots (light/dark, with and without input fields) and a tool to regenerate them.
- Tests: unit, component (jsdom), real browser (Chromium), cross-check against a Python reference writer.
