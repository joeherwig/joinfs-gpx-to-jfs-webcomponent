#!/usr/bin/env python3
"""
gpx2jfs - convert a GPX tracklog into a JoinFS recording (.jfs).

Format reference: tuduce/JoinFS  (Recorder.cs, Sim.cs "Streaming" region, RecordingXRay/RecordingReader.cs)

File layout (little endian, .NET BinaryWriter):
  int16  version
  int32  aircraftCount
    per aircraft:
      bool   plane
      string callsign, nickname, model          (7-bit length prefixed UTF-8)
      byte   typerole
      int32  frameCount
        per frame: byte type, double time(s), payload
      [version >= 21004] (FS2024 builds only) string livery
      [version >= 21005 for FS2024 / >= 21004 otherwise] string icaoType, string icaoAirline
  int32  objectCount (0)

Unit conventions used by JoinFS (radians, metres, m/s):
  lat/lon rad, altitude m MSL, heading rad true, pitch rad (+ = nose DOWN), bank rad (+ = LEFT wing down),
  velocity = world frame (X east, Y up, Z north) in m/s.
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

G = 9.80665
R_EARTH = 6371008.8
KT = 0.514444

FRAME_AIRCRAFT_POSITION = 1

TYPEROLES = {
    # 0 = unknown: JoinFS then skips the type-role comparison when matching a model
    "unknown": 0,
    "singleprop": 1, "twinprop": 2, "airliner": 3, "rotorcraft": 4, "glider": 5,
    "fighter": 6, "bomber": 7, "fourprop": 8, "airship": 9, "balloon": 10,
}


class GpxError(ValueError):
    pass


@dataclass
class Point:
    t: float      # unix seconds
    lat: float    # degrees
    lon: float    # degrees
    ele: float    # metres MSL


@dataclass
class Options:
    hz: float = 5.0                 # output frame rate
    model: str = "Cessna Skyhawk G1000 Asobo"
    typerole: int = 0               # 0 = unknown, 1 = single prop ... 10 = balloon
    callsign: str = "GPX"
    nickname: str = ""
    pitch_trim_deg: float = 2.0     # angle of attack added to flight-path angle
    max_bank_deg: float = 45.0
    ground_agl_m: float = 8.0       # <= this above start/end elevation counts as on the ground
    ground_max_kt: float = 90.0
    gap_s: float = 30.0             # gaps longer than this are treated as "parked" if barely moved
    smooth_s: float = 3.0           # heading/bank smoothing window
    jfs_version: int = 21003        # 21003 = no livery/ICAO strings, readable by every build
    fs2024: bool = False            # only matters if jfs_version >= 21004
    icao_type: str = ""
    icao_airline: str = ""
    livery: str = ""
    max_points: int = 200_000


# --------------------------------------------------------------------------- parsing

def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_gpx(data: bytes | str) -> tuple[list[Point], str]:
    """Return (points, track name). Uses all <trkpt>, falling back to <rtept>. Requires <time>."""
    raw = data if isinstance(data, bytes) else data.encode("utf-8")
    if b"<!DOCTYPE" in raw[:4096].upper() or b"<!ENTITY" in raw.upper():
        raise GpxError("DOCTYPE/ENTITY declarations are not allowed in GPX uploads")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise GpxError(f"Not a valid XML/GPX file: {e}") from None
    if _localname(root.tag) != "gpx":
        raise GpxError("Root element is not <gpx>")

    name = ""
    for el in root.iter():
        if _localname(el.tag) == "name" and (el.text or "").strip():
            name = el.text.strip()
            break

    def collect(tagname: str) -> list[Point]:
        out: list[Point] = []
        missing_time = 0
        for el in root.iter():
            if _localname(el.tag) != tagname:
                continue
            try:
                lat, lon = float(el.get("lat")), float(el.get("lon"))
            except (TypeError, ValueError):
                continue
            ele = None
            ts = None
            for ch in el:
                ln = _localname(ch.tag)
                if ln == "ele" and ch.text:
                    ele = float(ch.text)
                elif ln == "time" and ch.text:
                    ts = _parse_time(ch.text.strip())
            if ts is None:
                missing_time += 1
                continue
            out.append(Point(ts, lat, lon, ele if ele is not None else float("nan")))
        if missing_time and not out:
            raise GpxError("GPX has no <time> elements - a timed track is required for a replay")
        return out

    pts = collect("trkpt") or collect("rtept")
    if len(pts) < 2:
        raise GpxError("GPX needs at least 2 timed track points")

    # fill missing elevation by carrying neighbours; if none at all -> 0
    if all(math.isnan(p.ele) for p in pts):
        for p in pts:
            p.ele = 0.0
    else:
        last = next(p.ele for p in pts if not math.isnan(p.ele))
        for p in pts:
            if math.isnan(p.ele):
                p.ele = last
            else:
                last = p.ele
    return pts, name


def _parse_time(s: str) -> float:
    s = s.replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


# --------------------------------------------------------------------------- maths helpers

def _hav(a: Point, b: Point) -> float:
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dphi, dl = p2 - p1, math.radians(b.lon - a.lon)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(min(1.0, math.sqrt(h)))


def _clean(pts: list[Point]) -> list[Point]:
    pts = sorted(pts, key=lambda p: p.t)
    out = [pts[0]]
    for p in pts[1:]:
        if p.t - out[-1].t > 1e-3:
            out.append(p)
    return out


def _moving_avg(x: list[float], n: int) -> list[float]:
    if n <= 1:
        return x[:]
    h = n // 2
    pre = [0.0]
    for v in x:
        pre.append(pre[-1] + v)
    out = []
    L = len(x)
    for i in range(L):
        a, b = max(0, i - h), min(L, i + h + 1)
        out.append((pre[b] - pre[a]) / (b - a))
    return out


def _hermite(p0: float, p1: float, m0: float, m1: float, h: float, u: float) -> float:
    u2, u3 = u * u, u * u * u
    return ((2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * h * m0
            + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * h * m1)


def _angle_wrap(a: float) -> float:
    return (a + math.pi) % (2 * math.pi) - math.pi


# --------------------------------------------------------------------------- resampling

def resample(pts: list[Point], opt: Options) -> list[tuple[float, float, float, float]]:
    """Return [(t_rel, lat_deg, lon_deg, alt_m)] on a uniform grid. Cubic Hermite, gap aware."""
    n = len(pts)
    t0 = pts[0].t
    T = [p.t - t0 for p in pts]

    # local metric coordinates for tangent estimation (east, north), plus altitude
    lat0, lon0 = math.radians(pts[0].lat), math.radians(pts[0].lon)
    kx = R_EARTH * math.cos(lat0)
    E = [(math.radians(p.lon) - lon0) * kx for p in pts]
    N = [(math.radians(p.lat) - lat0) * R_EARTH for p in pts]
    A = [p.ele for p in pts]

    # per-segment "parked" flag: long gap and hardly any movement -> hold position
    parked = []
    for i in range(n - 1):
        dt = T[i + 1] - T[i]
        d = math.hypot(E[i + 1] - E[i], N[i + 1] - N[i])
        parked.append(dt > opt.gap_s and d / dt < 1.5)
    long_gap = [(T[i + 1] - T[i]) > opt.gap_s for i in range(n - 1)]

    def tangent(arr: list[float], i: int) -> float:
        # one-sided at ends and next to long gaps so we never overshoot across a gap
        left_ok = i > 0 and not long_gap[i - 1]
        right_ok = i < n - 1 and not long_gap[i]
        if left_ok and right_ok:
            return (arr[i + 1] - arr[i - 1]) / (T[i + 1] - T[i - 1])
        if right_ok:
            return (arr[i + 1] - arr[i]) / (T[i + 1] - T[i])
        if left_ok:
            return (arr[i] - arr[i - 1]) / (T[i] - T[i - 1])
        return 0.0

    mE = [tangent(E, i) for i in range(n)]
    mN = [tangent(N, i) for i in range(n)]
    mA = [tangent(A, i) for i in range(n)]

    dt_out = 1.0 / opt.hz
    total = T[-1]
    steps = int(total / dt_out) + 1
    out = []
    seg = 0
    for k in range(steps):
        t = k * dt_out
        while seg < n - 2 and T[seg + 1] < t:
            seg += 1
        h = T[seg + 1] - T[seg]
        u = min(1.0, max(0.0, (t - T[seg]) / h))
        if parked[seg]:
            # stay at point i until 1 s before the next point, then ease over the last second
            hold_until = T[seg + 1] - min(1.0, h)
            if t <= hold_until:
                e, nn, a = E[seg], N[seg], A[seg]
            else:
                v = (t - hold_until) / (T[seg + 1] - hold_until)
                e = E[seg] + (E[seg + 1] - E[seg]) * v
                nn = N[seg] + (N[seg + 1] - N[seg]) * v
                a = A[seg] + (A[seg + 1] - A[seg]) * v
        elif long_gap[seg]:
            e = E[seg] + (E[seg + 1] - E[seg]) * u
            nn = N[seg] + (N[seg + 1] - N[seg]) * u
            a = A[seg] + (A[seg + 1] - A[seg]) * u
        else:
            e = _hermite(E[seg], E[seg + 1], mE[seg], mE[seg + 1], h, u)
            nn = _hermite(N[seg], N[seg + 1], mN[seg], mN[seg + 1], h, u)
            a = _hermite(A[seg], A[seg + 1], mA[seg], mA[seg + 1], h, u)
        lat = math.degrees(lat0 + nn / R_EARTH)
        lon = math.degrees(lon0 + e / kx)
        out.append((t, lat, lon, a))
    return out


# --------------------------------------------------------------------------- derived attitude

@dataclass
class Sample:
    t: float
    lat: float      # rad
    lon: float      # rad
    alt: float      # m
    pitch: float    # rad, + = nose down (JoinFS/SimConnect convention)
    bank: float     # rad, + = left wing down
    heading: float  # rad 0..2pi true
    vE: float
    vU: float
    vN: float
    ground: bool
    elevation: float


def derive(grid: list[tuple[float, float, float, float]], opt: Options) -> list[Sample]:
    n = len(grid)
    dt = 1.0 / opt.hz
    t = [g[0] for g in grid]
    lat = [math.radians(g[1]) for g in grid]
    lon = [math.radians(g[2]) for g in grid]
    alt = [g[3] for g in grid]

    kx = [R_EARTH * math.cos(la) for la in lat]
    E = [0.0] * n
    N = [0.0] * n
    for i in range(1, n):
        E[i] = E[i - 1] + (lon[i] - lon[i - 1]) * kx[i]
        N[i] = N[i - 1] + (lat[i] - lat[i - 1]) * R_EARTH

    def diff(arr: list[float]) -> list[float]:
        out = [0.0] * n
        for i in range(n):
            a, b = max(0, i - 1), min(n - 1, i + 1)
            out[i] = (arr[b] - arr[a]) / ((b - a) * dt) if b > a else 0.0
        return out

    vE, vN, vU = diff(E), diff(N), diff(alt)
    win = max(1, int(opt.smooth_s * opt.hz)) | 1
    vE_s, vN_s, vU_s = _moving_avg(vE, win), _moving_avg(vN, win), _moving_avg(vU, win)
    gs = [math.hypot(a, b) for a, b in zip(vE_s, vN_s)]

    # heading = course over ground; hold last heading when (almost) stationary
    heading = [0.0] * n
    last = None
    for i in range(n):
        if gs[i] > 2.0:
            last = math.atan2(vE_s[i], vN_s[i])
        heading[i] = last if last is not None else float("nan")
    first_valid = next((h for h in heading if not math.isnan(h)), 0.0)
    heading = [first_valid if math.isnan(h) else h for h in heading]

    # heading rate -> coordinated-turn bank
    hdg_unwrapped = [heading[0]]
    for i in range(1, n):
        hdg_unwrapped.append(hdg_unwrapped[-1] + _angle_wrap(heading[i] - hdg_unwrapped[-1]))
    rate = _moving_avg(diff(hdg_unwrapped), win)
    max_b = math.radians(opt.max_bank_deg)
    bank_right = [max(-max_b, min(max_b, math.atan2(gs[i] * rate[i], G))) for i in range(n)]

    # ground state: close to start/end elevation and not too fast
    ref_start, ref_end = alt[0], alt[-1]
    mid = n // 2
    ground = []
    elev = []
    for i in range(n):
        ref = ref_start if i < mid else ref_end
        g = (alt[i] - ref) <= opt.ground_agl_m and gs[i] < opt.ground_max_kt * KT
        ground.append(g)
        elev.append(ref)

    gs_ground_ok = 1.0
    samples: list[Sample] = []
    for i in range(n):
        if ground[i]:
            pitch_up = 0.0
            bank_r = 0.0
        else:
            fpa = math.atan2(vU_s[i], max(gs[i], gs_ground_ok))
            pitch_up = max(-math.radians(30), min(math.radians(30), fpa + math.radians(opt.pitch_trim_deg)))
            bank_r = bank_right[i]
        samples.append(Sample(
            t=t[i], lat=lat[i], lon=lon[i], alt=alt[i],
            pitch=-pitch_up,                 # JoinFS: + = nose down
            bank=-bank_r,                    # JoinFS: + = left wing down
            heading=heading[i] % (2 * math.pi),
            vE=vE_s[i], vU=vU_s[i], vN=vN_s[i],
            ground=ground[i], elevation=elev[i],
        ))
    return samples


# --------------------------------------------------------------------------- writer

def _w_string(s: str) -> bytes:
    b = s.encode("utf-8")
    n = len(b)
    prefix = bytearray()
    while True:  # .NET 7-bit encoded int
        byte = n & 0x7F
        n >>= 7
        if n:
            prefix.append(byte | 0x80)
        else:
            prefix.append(byte)
            break
    return bytes(prefix) + b


def _frame(s: Sample, version: int) -> bytes:
    body = struct.pack(
        "<Bd3d3f3f3f3f5h",
        FRAME_AIRCRAFT_POSITION, s.t,
        s.lat, s.lon, s.alt,
        s.pitch, s.bank, s.heading,
        s.vE, s.vU, s.vN,          # linear velocity (world)
        0.0, 0.0, 0.0,             # angular velocity
        0.0, 0.0, 0.0,             # acceleration
        0, 0, 0, 0, 0,             # rudder, elevator, aileron, brakeL, brakeR (raw axis = value*16384)
    )
    body += struct.pack("<fB", s.elevation, 0x01 if s.ground else 0x00)   # flags: bit0 ground, bit1 elevation-correction off
    if version >= 21008:
        body += struct.pack("<f", float("nan"))                           # STATIC CG TO GROUND unknown
    return body


def write_jfs(samples: Iterable[Sample], opt: Options) -> bytes:
    samples = list(samples)
    v = opt.jfs_version
    if v < 10023:
        raise ValueError("jfs_version must be >= 10023")
    out = bytearray()
    out += struct.pack("<h", v)
    out += struct.pack("<i", 1)                                  # one aircraft
    out += struct.pack("<?", True)                               # plane
    out += _w_string(opt.callsign) + _w_string(opt.nickname) + _w_string(opt.model)
    out += struct.pack("<B", opt.typerole)
    out += struct.pack("<i", len(samples))
    for s in samples:
        out += _frame(s, v)
    if opt.fs2024 and v >= 21004:
        out += _w_string(opt.livery)
    if (opt.fs2024 and v >= 21005) or (not opt.fs2024 and v >= 21004):
        out += _w_string(opt.icao_type) + _w_string(opt.icao_airline)
    out += struct.pack("<i", 0)                                  # no non-aircraft objects
    return bytes(out)


# --------------------------------------------------------------------------- public API

def convert(gpx: bytes | str, opt: Options | None = None) -> tuple[bytes, dict]:
    opt = opt or Options()
    pts, name = parse_gpx(gpx)
    if len(pts) > opt.max_points:
        raise GpxError(f"Track too large ({len(pts)} points, limit {opt.max_points})")
    pts = _clean(pts)
    if len(pts) < 2:
        raise GpxError("Track has fewer than 2 distinct timestamps")
    dur = pts[-1].t - pts[0].t
    if dur * opt.hz > 1_500_000:
        raise GpxError("Track too long for the chosen frame rate")
    grid = resample(pts, opt)
    samples = derive(grid, opt)
    data = write_jfs(samples, opt)
    dist = sum(_hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    info = {
        "track_name": name,
        "input_points": len(pts),
        "frames": len(samples),
        "duration_s": round(dur, 1),
        "distance_km": round(dist / 1000, 2),
        "max_alt_m": round(max(p.ele for p in pts), 1),
        "max_speed_kt": round(max(math.hypot(s.vE, s.vN) for s in samples) / KT, 1),
        "bytes": len(data),
        "jfs_version": opt.jfs_version,
    }
    return data, info


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Convert a GPX tracklog to a JoinFS .jfs recording")
    ap.add_argument("gpx")
    ap.add_argument("-o", "--out")
    ap.add_argument("--model", default=Options.model, help="exact simulator aircraft title to replay with")
    ap.add_argument("--typerole", default="singleprop", choices=sorted(TYPEROLES))
    ap.add_argument("--callsign", default=Options.callsign)
    ap.add_argument("--nickname", default="")
    ap.add_argument("--hz", type=float, default=Options.hz)
    ap.add_argument("--jfs-version", type=int, default=Options.jfs_version)
    ap.add_argument("--fs2024", action="store_true")
    ap.add_argument("--icao-type", default="")
    ap.add_argument("--icao-airline", default="")
    a = ap.parse_args(argv)

    opt = Options(hz=a.hz, model=a.model, typerole=TYPEROLES[a.typerole], callsign=a.callsign,
                  nickname=a.nickname, jfs_version=a.jfs_version, fs2024=a.fs2024,
                  icao_type=a.icao_type, icao_airline=a.icao_airline)
    with open(a.gpx, "rb") as f:
        data, info = convert(f.read(), opt)
    out = a.out or (a.gpx.rsplit(".", 1)[0] + ".jfs")
    with open(out, "wb") as f:
        f.write(data)
    print(out, info)
    return 0


if __name__ == "__main__":
    sys.exit(main())
