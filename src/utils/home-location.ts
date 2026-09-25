/**
 * Fixed "home" observer location for home-dashboard features (satellite
 * passes). Kept in localStorage so kiosk / iframe setups work without a
 * geolocation grant. `?home=<lat>,<lon>` in the page URL sets and persists it.
 */

export interface HomeLocation {
  lat: number;
  lon: number;
}

const STORAGE_KEY = 'wm-home-location';
const URL_PARAM = 'home';

/** Parse `"48.137,11.575"`; null when malformed or out of range. */
export function parseHomeLocation(value: string | null | undefined): HomeLocation | null {
  if (!value) return null;
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => !/^-?\d+(?:\.\d+)?$/.test(part))) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
}

export function formatHomeLocation(home: HomeLocation): string {
  return `${home.lat.toFixed(4)},${home.lon.toFixed(4)}`;
}

function readStored(): HomeLocation | null {
  try {
    return parseHomeLocation(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function setHomeLocation(home: HomeLocation): void {
  try {
    localStorage.setItem(STORAGE_KEY, formatHomeLocation(home));
  } catch { /* storage blocked: the value lives only for this page */ }
  window.dispatchEvent(new CustomEvent('wm:home-location', { detail: home }));
}

/** URL `?home=` wins (and is persisted), then the stored value. */
export function getHomeLocation(): HomeLocation | null {
  try {
    const fromUrl = parseHomeLocation(new URLSearchParams(window.location.search).get(URL_PARAM));
    if (fromUrl) {
      const stored = readStored();
      if (!stored || stored.lat !== fromUrl.lat || stored.lon !== fromUrl.lon) {
        try { localStorage.setItem(STORAGE_KEY, formatHomeLocation(fromUrl)); } catch { /* ignore */ }
      }
      return fromUrl;
    }
  } catch { /* no window.location (tests) */ }
  return readStored();
}

/** Ask the browser for the current position. Call from a user gesture. */
export function requestBrowserLocation(timeoutMs = 10_000): Promise<HomeLocation> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Geolocation is not available in this browser'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: Math.round(pos.coords.latitude * 1e5) / 1e5,
        lon: Math.round(pos.coords.longitude * 1e5) / 1e5,
      }),
      (err) => reject(new Error(err.message || 'Location request was denied')),
      { timeout: timeoutMs, maximumAge: 600_000 },
    );
  });
}
