import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createLocalAdsbHandler,
  fetchLocalFeedDocument,
  isLocalIpv4,
  isLocalReceiverAddress,
  mergeLocalAdsbRecords,
  normalizeDump1090Aircraft,
  parseLocalAdsbFeeds,
  resolveLocalFeedAddresses,
} from './local-adsb.mjs';
import { createLocalApiServer } from './local-api-server.mjs';
import { buildFixtureDocument } from '../../scripts/local-adsb-fixture-server.mjs';

const quietLogger = { info() {}, warn() {}, error() {}, log() {} };

test('isLocalIpv4 accepts only loopback and RFC1918', () => {
  for (const ok of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.178.20']) {
    assert.equal(isLocalIpv4(ok), true, ok);
  }
  for (const bad of ['8.8.8.8', '169.254.169.254', '172.32.0.1', '100.64.0.1', '192.169.0.1', '999.1.1.1', '10.0.0', 'localhost']) {
    assert.equal(isLocalIpv4(bad), false, bad);
  }
  assert.equal(isLocalReceiverAddress('::1'), true);
  assert.equal(isLocalReceiverAddress('::ffff:192.168.1.2'), true);
  assert.equal(isLocalReceiverAddress('::ffff:8.8.8.8'), false);
  assert.equal(isLocalReceiverAddress('fe80::1'), false);
});

test('parseLocalAdsbFeeds validates every entry and never exposes URLs in labels', () => {
  const { configured, feeds } = parseLocalAdsbFeeds([
    '1090=http://192.168.1.50:8080/data/aircraft.json',
    '978=http://piaware.local/skyaware978/data/aircraft.json',
    '1090=http://host.docker.internal:8080/tar1090/data/aircraft.json',
    '1090=http://8.8.8.8/data/aircraft.json',
    '1090=http://169.254.169.254/latest/aircraft.json',
    '1090=http://example.com/data/aircraft.json',
    '1090=http://user:pw@192.168.1.50/data/aircraft.json',
    '1090=http://192.168.1.50/data/aircraft.json?x=1',
    '1090=http://192.168.1.50/etc/passwd',
    '1090=file:///etc/aircraft.json',
    '433=http://192.168.1.50/data/aircraft.json',
    'garbage',
  ].join(','));
  assert.equal(configured, true);
  assert.equal(feeds.length, 12);
  assert.ok(feeds[0].url && feeds[1].url && feeds[2].url);
  assert.equal(feeds[1].label, '978 MHz UAT');
  assert.equal(feeds[0].label, '1090 MHz #1');
  for (const feed of feeds.slice(3)) {
    assert.ok(feed.reason, `expected rejection for ${feed.id}`);
    assert.equal(feed.url, undefined);
  }
  for (const feed of feeds) assert.doesNotMatch(feed.label, /192\.168|http/);
  assert.deepEqual(parseLocalAdsbFeeds(''), { configured: false, feeds: [] });
  assert.deepEqual(parseLocalAdsbFeeds(undefined), { configured: false, feeds: [] });
});

test('resolveLocalFeedAddresses refuses names that resolve outside the LAN', async () => {
  const lookup = (answers) => async () => answers;
  assert.deepEqual(
    await resolveLocalFeedAddresses('pi.local', lookup([{ address: '192.168.1.9', family: 4 }])),
    [{ address: '192.168.1.9', family: 4 }],
  );
  await assert.rejects(
    resolveLocalFeedAddresses('pi.local', lookup([{ address: '192.168.1.9', family: 4 }, { address: '1.2.3.4', family: 4 }])),
    { code: 'FORBIDDEN_ADDRESS' },
  );
  await assert.rejects(
    resolveLocalFeedAddresses('pi.local', async () => { throw new Error('ENOTFOUND'); }),
    { code: 'UNRESOLVED' },
  );
  // IP literals skip DNS entirely.
  assert.deepEqual(
    await resolveLocalFeedAddresses('10.0.0.2', async () => { throw new Error('must not resolve'); }),
    [{ address: '10.0.0.2', family: 4 }],
  );
});

test('fetchLocalFeedDocument pins the socket to the validated addresses', async () => {
  let seenLookup;
  const doc = await fetchLocalFeedDocument('http://pi.local/data/aircraft.json', {
    lookupImpl: async () => [{ address: '192.168.1.9', family: 4 }],
    requestImpl: async (_url, { lookup }) => {
      seenLookup = lookup;
      return { status: 200, text: JSON.stringify({ now: 1, aircraft: [] }) };
    },
  });
  assert.deepEqual(doc, { now: 1, aircraft: [] });
  await new Promise((resolve) => {
    seenLookup('pi.local', {}, (err, address, family) => {
      assert.equal(err, null);
      assert.equal(address, '192.168.1.9');
      assert.equal(family, 4);
      resolve();
    });
  });
});

test('fetchLocalFeedDocument maps failures to stable codes', async () => {
  const lookupImpl = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    fetchLocalFeedDocument('http://127.0.0.1/aircraft.json', { lookupImpl, requestImpl: async () => ({ status: 200, text: 'nope' }) }),
    { code: 'BAD_JSON' },
  );
  await assert.rejects(
    fetchLocalFeedDocument('http://127.0.0.1/aircraft.json', { lookupImpl, requestImpl: async () => ({ status: 200, text: '{"now":1}' }) }),
    { code: 'BAD_DOCUMENT' },
  );
  await assert.rejects(
    fetchLocalFeedDocument('http://127.0.0.1/aircraft.json', {
      lookupImpl,
      timeoutMs: 20,
      requestImpl: (_url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }),
    { code: 'TIMEOUT' },
  );
});

test('normalizeDump1090Aircraft keeps positioned aircraft and normalizes fields', () => {
  const records = normalizeDump1090Aircraft({
    now: 1000,
    aircraft: [
      { hex: '3C6444', flight: 'DLH4AB  ', lat: 48.1, lon: 11.5, alt_baro: 11000, gs: 250, track: 370, seen_pos: 2, category: 'a3', rssi: -10 },
      { hex: 'abc123', lat: 48.2, lon: 11.6, alt_baro: 'ground', seen_pos: 0 },
      { hex: '3c56ef', alt_baro: 15000 },
      { hex: 'nothex', lat: 1, lon: 1, seen_pos: 0 },
      { hex: '3c6445', lat: 95, lon: 11, seen_pos: 0 },
    ],
  }, 1_000_000, '1090');
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    icao: '3c6444', callsign: 'DLH4AB', category: 'A3', lat: 48.1, lon: 11.5, onGround: false,
    altitudeFt: 11000, groundSpeedKt: 250, trackDeg: 10, verticalRateFpm: null, rssiDbfs: -10,
    positionAt: 998_000, bands: ['1090'],
  });
  assert.equal(records[1].onGround, true);
  assert.equal(records[1].altitudeFt, 0);
  assert.equal(records[1].callsign, null);
});

test('mergeLocalAdsbRecords keeps the newest position and unions bands', () => {
  const merged = mergeLocalAdsbRecords([
    { icao: 'a1', lat: 1, lon: 1, positionAt: 9_000, bands: ['1090'] },
    { icao: 'a1', lat: 2, lon: 2, positionAt: 9_500, bands: ['978'] },
    { icao: 'b2', lat: 3, lon: 3, positionAt: 1_000, bands: ['1090'] },
  ], 10_000, 5_000);
  assert.deepEqual(merged, [{ icao: 'a1', lat: 2, lon: 2, bands: ['1090', '978'], positionAgeS: 1 }]);
});

test('handler reports unconfigured, invalid, stale and live feeds', async () => {
  const unconfigured = createLocalAdsbHandler({ feedsValue: '', logger: quietLogger });
  const empty = await (await unconfigured.handle({ method: 'GET' })).json();
  assert.equal(empty.configured, false);
  assert.deepEqual(empty.aircraft, []);

  const now = 2_000_000;
  const handler = createLocalAdsbHandler({
    feedsValue: '1090=http://192.168.1.9/data/aircraft.json,978=http://192.168.1.9/uat/aircraft.json,1090=http://8.8.8.8/aircraft.json',
    logger: quietLogger,
    now: () => now,
    requestImpl: async (url) => ({
      status: 200,
      text: JSON.stringify(url.includes('uat')
        ? { now: (now - 60_000) / 1000, aircraft: [] }
        : buildFixtureDocument(now, { lat: 48.1, lon: 11.5 })),
    }),
  });
  const res = await handler.handle({ method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.feeds.map((f) => f.status), ['live', 'stale', 'invalid']);
  assert.equal(body.aircraft.length, 6, 'fixture has six positioned aircraft');
  assert.ok(body.aircraft.every((a) => a.bands.includes('1090') && Number.isFinite(a.lat)));
  assert.equal(JSON.stringify(body).includes('192.168'), false, 'feed addresses must not reach the browser');

  const post = await handler.handle({ method: 'POST' });
  assert.equal(post.status, 405);
});

test('handler coalesces concurrent polls and caches for cacheMs', async () => {
  let calls = 0;
  let clock = 0;
  const handler = createLocalAdsbHandler({
    feedsValue: '1090=http://127.0.0.1:1/aircraft.json',
    logger: quietLogger,
    now: () => clock,
    cacheMs: 1000,
    requestImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 200, text: JSON.stringify({ now: 0, aircraft: [] }) };
    },
  });
  await Promise.all([handler.handle({}), handler.handle({}), handler.handle({})]);
  assert.equal(calls, 1);
  clock = 500;
  await handler.handle({});
  assert.equal(calls, 1);
  clock = 1500;
  await handler.handle({});
  assert.equal(calls, 2);
});

test('sidecar serves /api/local-adsb/aircraft behind the auth gate from a real LAN feed', async () => {
  const receiver = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildFixtureDocument(Date.now(), { lat: 48.137, lon: 11.575 })));
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = receiver.address().port;
  const apiDir = await mkdtemp(path.join(os.tmpdir(), 'wm-local-adsb-'));
  const previousToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'local-adsb-test-token';
  const app = await createLocalApiServer({
    port: 0,
    apiDir,
    cloudFallback: 'false',
    logger: quietLogger,
    localAdsbFeeds: `1090=http://127.0.0.1:${receiverPort}/data/aircraft.json`,
  });
  const { port } = await app.start();
  try {
    const url = `http://127.0.0.1:${port}/api/local-adsb/aircraft`;
    assert.equal((await fetch(url)).status, 401);
    const res = await fetch(url, { headers: { Authorization: 'Bearer local-adsb-test-token' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.configured, true);
    assert.equal(body.feeds[0].status, 'live');
    assert.equal(body.aircraft.length, 6);
  } finally {
    await app.close();
    await new Promise((resolve) => receiver.close(resolve));
    await rm(apiDir, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.LOCAL_API_TOKEN;
    else process.env.LOCAL_API_TOKEN = previousToken;
  }
});

test('ships local-adsb.mjs next to the sidecar in Docker and Tauri bundles', () => {
  const config = JSON.parse(readFileSync(new URL('../tauri.conf.json', import.meta.url), 'utf8'));
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.ok(config.bundle.resources.includes('sidecar/local-adsb.mjs'));
  assert.match(dockerfile, /COPY --from=builder \/app\/src-tauri\/sidecar\/local-adsb\.mjs \.\/local-adsb\.mjs/);
});
