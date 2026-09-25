import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as satellite from 'satellite.js';
import { azimuthToCompass, predictPasses, predictPassesForSatellite } from '../src/services/satellite-passes.ts';
import { parseHomeLocation } from '../src/utils/home-location.ts';

// ISS TLE from the satellite.js README (epoch 2019-06-05); fixed so the test
// is deterministic.
const ISS = {
  satrec: satellite.twoline2satrec(
    '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992',
    '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442',
  ),
  meta: { noradId: '25544', name: 'ISS (ZARYA)', type: 'station', country: 'INT' },
};
const MUNICH = { lat: 48.137, lon: 11.575, altM: 520 };
const START = Date.UTC(2019, 5, 5, 12, 0, 0);

function elevationAt(ms: number): number {
  const date = new Date(ms);
  const pv = satellite.propagate(ISS.satrec, date);
  const pos = pv!.position as satellite.EciVec3<number>;
  const ecf = satellite.eciToEcf(pos, satellite.gstime(date));
  const look = satellite.ecfToLookAngles({
    latitude: satellite.degreesToRadians(MUNICH.lat),
    longitude: satellite.degreesToRadians(MUNICH.lon),
    height: MUNICH.altM / 1000,
  }, ecf);
  return (look.elevation * 180) / Math.PI;
}

/** Brute-force reference: 1 s sampling over the same window. */
function referencePasses(minElevationDeg: number, hours: number) {
  const passes: Array<{ riseAt: number; setAt: number; maxElevationDeg: number }> = [];
  let open: { riseAt: number; max: number } | null = null;
  for (let ms = START; ms <= START + hours * 3_600_000; ms += 1000) {
    const e = elevationAt(ms);
    if (!open && e >= minElevationDeg) open = { riseAt: ms, max: e };
    else if (open && e >= minElevationDeg) open.max = Math.max(open.max, e);
    else if (open && e < minElevationDeg) {
      passes.push({ riseAt: open.riseAt, setAt: ms, maxElevationDeg: open.max });
      open = null;
    }
  }
  return passes;
}

describe('satellite pass prediction', () => {
  it('matches a 1 s brute-force reference for rise, set and culmination', () => {
    const predicted = predictPassesForSatellite(satellite, ISS, MUNICH, { startMs: START, hours: 24, minElevationDeg: 10 });
    const reference = referencePasses(10, 24);
    assert.ok(reference.length >= 3, `expected several ISS passes, got ${reference.length}`);
    assert.equal(predicted.length, reference.length);
    predicted.forEach((pass, i) => {
      const ref = reference[i]!;
      assert.ok(Math.abs(pass.riseAt - ref.riseAt) <= 2000, `rise ${i} off by ${pass.riseAt - ref.riseAt} ms`);
      assert.ok(Math.abs(pass.setAt - ref.setAt) <= 2000, `set ${i} off by ${pass.setAt - ref.setAt} ms`);
      assert.ok(Math.abs(pass.maxElevationDeg - ref.maxElevationDeg) <= 0.2, `max elevation ${i}: ${pass.maxElevationDeg} vs ${ref.maxElevationDeg}`);
      assert.ok(pass.culminationAt > pass.riseAt && pass.culminationAt < pass.setAt);
      assert.equal(pass.inProgress, false);
      assert.equal(pass.name, 'ISS (ZARYA)');
    });
  });

  it('reports a pass already in progress at the window start', () => {
    const [first] = predictPassesForSatellite(satellite, ISS, MUNICH, { startMs: START, hours: 24, minElevationDeg: 10 });
    const midPass = first!.riseAt + 60_000;
    const [current] = predictPassesForSatellite(satellite, ISS, MUNICH, { startMs: midPass, hours: 1, minElevationDeg: 10 });
    assert.equal(current!.inProgress, true);
    assert.equal(current!.riseAt, midPass);
    assert.ok(Math.abs(current!.setAt - first!.setAt) <= 2000);
  });

  it('merges satellites sorted by rise time and honours abort', async () => {
    const other = { ...ISS, meta: { ...ISS.meta, noradId: '99999', name: 'COPY' } };
    const all = await predictPasses(satellite, [ISS, other], MUNICH, { startMs: START, hours: 12 });
    assert.ok(all.length >= 2);
    for (let i = 1; i < all.length; i++) assert.ok(all[i]!.riseAt >= all[i - 1]!.riseAt);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(predictPasses(satellite, [ISS], MUNICH, { signal: controller.signal }), { name: 'AbortError' });
  });

  it('formats azimuths as compass points', () => {
    assert.equal(azimuthToCompass(0), 'N');
    assert.equal(azimuthToCompass(44), 'NE');
    assert.equal(azimuthToCompass(180), 'S');
    assert.equal(azimuthToCompass(337), 'NW');
    assert.equal(azimuthToCompass(359), 'N');
  });
});

describe('home location parsing', () => {
  it('accepts lat,lon and rejects malformed input', () => {
    assert.deepEqual(parseHomeLocation('48.137,11.575'), { lat: 48.137, lon: 11.575 });
    assert.deepEqual(parseHomeLocation(' -33.8688 , 151.2093 '), { lat: -33.8688, lon: 151.2093 });
    for (const bad of ['', '48.1', '91,0', '0,181', 'abc,def', '1e3,2', '48.1,11.5,3', null, undefined]) {
      assert.equal(parseHomeLocation(bad as string), null, String(bad));
    }
  });
});
