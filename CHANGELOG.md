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
