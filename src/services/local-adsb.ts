import { toApiUrl } from '@/services/runtime';

/**
 * Local ADS-B: aircraft heard by the operator's own receivers
 * (dump1090 / readsb / tar1090 / skyaware978), served by the sidecar at
 * /api/local-adsb/aircraft. Only the desktop sidecar and the docker
 * self-host stack have this route; the hosted web app cannot reach a LAN,
 * so there the layer reports itself as unavailable.
 */

export type LocalAdsbFeedStatus = 'live' | 'stale' | 'unreachable' | 'invalid';

export interface LocalAdsbFeed {
  band: '1090' | '978' | null;
  label: string;
  status: LocalAdsbFeedStatus;
  aircraft: number;
  ageMs: number | null;
}

export interface LocalAdsbAircraft {
  icao: string;
  callsign: string | null;
  category: string | null;
  lat: number;
  lon: number;
  onGround: boolean;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  verticalRateFpm: number | null;
  rssiDbfs: number | null;
  bands: string[];
  positionAgeS: number;
}

export type LocalAdsbAvailability = 'ok' | 'unconfigured' | 'unavailable';

export interface LocalAdsbSnapshot {
  availability: LocalAdsbAvailability;
  feeds: LocalAdsbFeed[];
  aircraft: LocalAdsbAircraft[];
  generatedAt: number;
}

const LOCAL_ADSB_PATH = '/api/local-adsb/aircraft';

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toAircraft(raw: unknown): LocalAdsbAircraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const lat = finiteOrNull(a.lat);
  const lon = finiteOrNull(a.lon);
  if (typeof a.icao !== 'string' || lat === null || lon === null) return null;
  return {
    icao: a.icao,
    callsign: typeof a.callsign === 'string' ? a.callsign : null,
    category: typeof a.category === 'string' ? a.category : null,
    lat,
    lon,
    onGround: a.onGround === true,
    altitudeFt: finiteOrNull(a.altitudeFt),
    groundSpeedKt: finiteOrNull(a.groundSpeedKt),
    trackDeg: finiteOrNull(a.trackDeg),
    verticalRateFpm: finiteOrNull(a.verticalRateFpm),
    rssiDbfs: finiteOrNull(a.rssiDbfs),
    bands: Array.isArray(a.bands) ? a.bands.filter((b): b is string => typeof b === 'string') : [],
    positionAgeS: finiteOrNull(a.positionAgeS) ?? 0,
  };
}

/** Parse the sidecar payload. Exported for tests. */
export function parseLocalAdsbPayload(payload: unknown): LocalAdsbSnapshot {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const feeds = Array.isArray(body.feeds) ? (body.feeds as LocalAdsbFeed[]) : [];
  const aircraft = Array.isArray(body.aircraft)
    ? body.aircraft.map(toAircraft).filter((a): a is LocalAdsbAircraft => a !== null)
    : [];
  return {
    availability: body.configured === true ? 'ok' : 'unconfigured',
    feeds,
    aircraft,
    generatedAt: finiteOrNull(body.generatedAt) ?? Date.now(),
  };
}

export async function fetchLocalAdsb(signal?: AbortSignal): Promise<LocalAdsbSnapshot> {
  const timeout = AbortSignal.timeout(5000);
  const resp = await fetch(toApiUrl(LOCAL_ADSB_PATH), {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  // 404: this deployment has no sidecar (hosted web / plain Vite dev).
  if (resp.status === 404) {
    return { availability: 'unavailable', feeds: [], aircraft: [], generatedAt: Date.now() };
  }
  if (!resp.ok) throw new Error(`Local ADS-B fetch failed: ${resp.status}`);
  return parseLocalAdsbPayload(await resp.json());
}
