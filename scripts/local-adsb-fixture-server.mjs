#!/usr/bin/env node
// Simulated dump1090/readsb receiver for the Local ADS-B layer.
//
// Serves a dump1090-compatible `aircraft.json` whose aircraft circle a home
// position, so the Local ADS-B pipeline can be exercised without an RTL-SDR
// receiver. The document shape matches what dump1090-fa, readsb and tar1090
// write (`now`, `messages`, `aircraft[]` with hex/flight/lat/lon/alt_baro/gs/
// track/seen_pos/rssi).
//
// Usage:
//   node scripts/local-adsb-fixture-server.mjs
//   FIXTURE_LAT=48.137 FIXTURE_LON=11.575 FIXTURE_PORT=8080 FIXTURE_HOST=0.0.0.0 \
//     node scripts/local-adsb-fixture-server.mjs
//
// Then point the sidecar's LOCAL_ADSB_FEEDS at it; SELF_HOSTING.md
// ("Local ADS-B receivers") has the docker example.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const FIXTURE_AIRCRAFT = [
  { hex: '3c6444', flight: 'DLH4AB', radiusKm: 12, speedKt: 250, altFt: 11000, category: 'A3' },
  { hex: '4b1805', flight: 'SWR17K', radiusKm: 25, speedKt: 380, altFt: 24000, category: 'A3' },
  { hex: '3c4b26', flight: 'EWG8TP', radiusKm: 40, speedKt: 450, altFt: 36000, category: 'A3' },
  { hex: '440123', flight: 'AUA55', radiusKm: 55, speedKt: 470, altFt: 38000, category: 'A3' },
  { hex: '3d0a12', flight: 'DEXYZ', radiusKm: 6, speedKt: 110, altFt: 3500, category: 'A1' },
  { hex: '3ddc9f', flight: 'CHX11', radiusKm: 3, speedKt: 90, altFt: 1200, category: 'A7' },
];

/**
 * Build one aircraft.json document for `nowMs`.
 * @param {number} nowMs
 * @param {{lat:number, lon:number}} home
 */
export function buildFixtureDocument(nowMs, { lat, lon }) {
  const nowS = nowMs / 1000;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  const aircraft = FIXTURE_AIRCRAFT.map((plane, index) => {
    // Orbit period that yields the aircraft's ground speed on its circle.
    const periodS = (2 * Math.PI * plane.radiusKm) / ((plane.speedKt * 1.852) / 3600);
    const phase = ((nowS / periodS) + index / FIXTURE_AIRCRAFT.length) * 2 * Math.PI;
    const direction = index % 2 === 0 ? 1 : -1;
    const angle = direction * phase;
    // Heading is tangent to the circle (east = cos, north = sin of angle),
    // measured clockwise from north.
    const east = -Math.sin(angle) * direction;
    const north = Math.cos(angle) * direction;
    const trackDeg = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
    return {
      hex: plane.hex,
      flight: `${plane.flight.padEnd(8, ' ')}`,
      category: plane.category,
      alt_baro: plane.altFt,
      gs: plane.speedKt,
      track: Math.round(trackDeg * 10) / 10,
      baro_rate: 0,
      lat: Math.round((lat + (plane.radiusKm * Math.sin(angle)) / kmPerDegLat) * 1e6) / 1e6,
      lon: Math.round((lon + (plane.radiusKm * Math.cos(angle)) / kmPerDegLon) * 1e6) / 1e6,
      seen_pos: 0.4,
      seen: 0.2,
      messages: 1000 + Math.floor(nowS) % 100000,
      rssi: -12 - index * 3.5,
    };
  });
  // One aircraft heard without a position (Mode S only), as real feeds have.
  aircraft.push({ hex: '3c56ef', flight: 'NOPOS1  ', alt_baro: 15000, seen: 1.1, messages: 42, rssi: -30.1 });
  return { now: Math.round(nowS * 10) / 10, messages: 123456, aircraft };
}

function startFixtureServer({
  host = process.env.FIXTURE_HOST || '127.0.0.1',
  port = Number(process.env.FIXTURE_PORT || 8080),
  lat = Number(process.env.FIXTURE_LAT || 48.137),
  lon = Number(process.env.FIXTURE_LON || 11.575),
} = {}) {
  const server = createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (!pathname.endsWith('/aircraft.json')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found. Try /data/aircraft.json\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(buildFixtureDocument(Date.now(), { lat, lon })));
  });
  server.listen(port, host, () => {
    console.log(`[local-adsb-fixture] serving http://${host}:${port}/data/aircraft.json around ${lat}, ${lon}`);
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startFixtureServer();
}
