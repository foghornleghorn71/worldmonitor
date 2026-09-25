import type { SatRec } from 'satellite.js';
import type { SatRecEntry } from '@/services/satellites';

/**
 * Overhead pass prediction for a fixed observer ("when is which tracked
 * satellite above my home?"). Pure functions over satellite.js; the caller
 * supplies the loaded library so this module adds nothing to the eager
 * bundle and can be tested under node.
 *
 * Method: sample elevation every `stepS` seconds; each upward crossing of
 * `minElevationDeg` starts a pass, rise and set are refined by bisection to
 * ~1 s, and the culmination is refined by golden-section search around the
 * highest sample. A 60 s step reliably catches LEO passes above 10°, which
 * last several minutes.
 */

type SatelliteLib = Pick<typeof import('satellite.js'),
  'propagate' | 'gstime' | 'eciToEcf' | 'ecfToLookAngles' | 'degreesToRadians'>;

export interface Observer {
  lat: number;
  lon: number;
  /** Height above the ellipsoid in metres. */
  altM?: number;
}

export interface SatellitePass {
  noradId: string;
  name: string;
  type: string;
  country: string;
  /** Epoch ms. For a pass already in progress at `startMs`, this is `startMs`. */
  riseAt: number;
  setAt: number;
  culminationAt: number;
  maxElevationDeg: number;
  riseAzimuthDeg: number;
  setAzimuthDeg: number;
  /** True when the satellite was already above the threshold at `startMs`. */
  inProgress: boolean;
}

export interface PassOptions {
  startMs?: number;
  hours?: number;
  minElevationDeg?: number;
  stepS?: number;
}

interface Look { elevationDeg: number; azimuthDeg: number }

const RAD = 180 / Math.PI;

function lookAt(lib: SatelliteLib, satrec: SatRec, observerGd: { latitude: number; longitude: number; height: number }, ms: number): Look | null {
  const date = new Date(ms);
  const pv = lib.propagate(satrec, date);
  const position = pv?.position;
  if (!position || typeof position === 'boolean') return null;
  const ecf = lib.eciToEcf(position, lib.gstime(date));
  const look = lib.ecfToLookAngles(observerGd, ecf);
  if (!Number.isFinite(look.elevation) || !Number.isFinite(look.azimuth)) return null;
  return { elevationDeg: look.elevation * RAD, azimuthDeg: ((look.azimuth * RAD) % 360 + 360) % 360 };
}

/** Find the threshold crossing between `lo` (below) and `hi` (above) or vice versa. */
function bisectCrossing(elev: (ms: number) => number, lo: number, hi: number, threshold: number): number {
  const loAbove = elev(lo) >= threshold;
  let a = lo;
  let b = hi;
  while (b - a > 1000) {
    const mid = (a + b) / 2;
    if ((elev(mid) >= threshold) === loAbove) a = mid;
    else b = mid;
  }
  return Math.round((a + b) / 2);
}

function goldenMax(elev: (ms: number) => number, lo: number, hi: number): number {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  while (b - a > 1000) {
    if (elev(c) > elev(d)) b = d;
    else a = c;
    c = b - phi * (b - a);
    d = a + phi * (b - a);
  }
  return Math.round((a + b) / 2);
}

/** Passes of one satellite over `observer`, in time order. */
export function predictPassesForSatellite(
  lib: SatelliteLib,
  entry: SatRecEntry,
  observer: Observer,
  { startMs = Date.now(), hours = 24, minElevationDeg = 10, stepS = 60 }: PassOptions = {},
): SatellitePass[] {
  const observerGd = {
    latitude: lib.degreesToRadians(observer.lat),
    longitude: lib.degreesToRadians(observer.lon),
    height: (observer.altM ?? 0) / 1000,
  };
  const endMs = startMs + hours * 3_600_000;
  const stepMs = stepS * 1000;
  const look = (ms: number) => lookAt(lib, entry.satrec, observerGd, ms);
  // A failed propagation reads as far below the horizon.
  const elev = (ms: number) => look(ms)?.elevationDeg ?? -90;

  const passes: SatellitePass[] = [];
  let prevMs = startMs;
  let prevElev = elev(startMs);
  let current: { riseAt: number; inProgress: boolean; bestMs: number; bestElev: number } | null =
    prevElev >= minElevationDeg ? { riseAt: startMs, inProgress: true, bestMs: startMs, bestElev: prevElev } : null;

  const closePass = (setAt: number) => {
    if (!current) return;
    const culminationAt = goldenMax(elev, Math.max(current.riseAt, current.bestMs - stepMs), Math.min(setAt, current.bestMs + stepMs));
    const culminationElev = Math.max(elev(culminationAt), current.bestElev);
    passes.push({
      ...entry.meta,
      riseAt: current.riseAt,
      setAt,
      culminationAt,
      maxElevationDeg: Math.round(culminationElev * 10) / 10,
      riseAzimuthDeg: Math.round(look(current.riseAt)?.azimuthDeg ?? 0),
      setAzimuthDeg: Math.round(look(setAt)?.azimuthDeg ?? 0),
      inProgress: current.inProgress,
    });
    current = null;
  };

  for (let ms = startMs + stepMs; ms <= endMs; ms += stepMs) {
    const e = elev(ms);
    if (!current && e >= minElevationDeg && prevElev < minElevationDeg) {
      current = { riseAt: bisectCrossing(elev, prevMs, ms, minElevationDeg), inProgress: false, bestMs: ms, bestElev: e };
    } else if (current && e >= minElevationDeg && e > current.bestElev) {
      current.bestMs = ms;
      current.bestElev = e;
    } else if (current && e < minElevationDeg) {
      closePass(bisectCrossing(elev, prevMs, ms, minElevationDeg));
    }
    prevMs = ms;
    prevElev = e;
  }
  // A pass still in progress at the window end is dropped: its set time is unknown.
  return passes;
}

/**
 * Passes of every satellite, sorted by rise time. Yields to the event loop
 * between satellites so a few hundred TLEs do not block the UI.
 */
export async function predictPasses(
  lib: SatelliteLib,
  entries: SatRecEntry[],
  observer: Observer,
  options: PassOptions & { signal?: AbortSignal } = {},
): Promise<SatellitePass[]> {
  const startMs = options.startMs ?? Date.now();
  const passes: SatellitePass[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      passes.push(...predictPassesForSatellite(lib, entries[i]!, observer, { ...options, startMs }));
    } catch { /* skip satellites that fail to propagate */ }
    if (i % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return passes.sort((a, b) => a.riseAt - b.riseAt);
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function azimuthToCompass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}
