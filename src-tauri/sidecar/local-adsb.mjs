// Local ADS-B receiver feeds for the sidecar (desktop + docker self-host).
//
// A user who runs dump1090-fa / readsb / tar1090 (1090 MHz) or dump978-fa +
// skyaware978 (978 MHz UAT) exposes an `aircraft.json` over HTTP on their own
// network. This module reads those documents, merges them by ICAO address and
// serves one snapshot at GET /api/local-adsb/aircraft.
//
// Adapted from God's Eye View (server/providers/local-receivers.js,
// src/data/tapAddress.js, src/sources/adsbRecords.js),
// https://github.com/bilawalsidhu/gods-eye-view
// Copyright (c) 2026 Bilawal Sidhu. Used under the MIT License:
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit
//   persons to whom the Software is furnished to do so, subject to the
//   following conditions: The above copyright notice and this permission
//   notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
//   EXPRESS OR IMPLIED.
//
// Trust boundary: the feed list comes only from the operator's
// LOCAL_ADSB_FEEDS environment value; the browser never supplies an address.
// Every host must be loopback or RFC1918 IPv4, `localhost`, a `*.local` mDNS
// name, or `host.docker.internal`. Names are resolved before every read, each
// resolved address must itself be loopback/RFC1918, and the socket is pinned
// to exactly those addresses so a re-resolution cannot redirect it. Redirects
// are refused and the body is size-capped while it streams. Requests are made
// with node:http(s) directly, so the sidecar's public-only fetch guard is not
// widened for anything else.

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';

export const LOCAL_ADSB_ROUTE = '/api/local-adsb/aircraft';
export const LOCAL_ADSB_FEEDS_ENV = 'LOCAL_ADSB_FEEDS';
export const LOCAL_ADSB_BANDS = Object.freeze(['1090', '978']);
export const LOCAL_ADSB_TIMEOUT_MS = 2_000;
export const LOCAL_ADSB_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const LOCAL_ADSB_CACHE_MS = 1_000;
/** A feed whose own `now` is older than this is reported stale. */
export const LOCAL_ADSB_STALE_MS = 10_000;
/** Aircraft whose last position is older than this are not returned. */
export const LOCAL_ADSB_POSITION_MAX_AGE_MS = 60_000;
const MAX_FEEDS = 8;
const LOG_PREFIX = '[local-adsb]';
const USER_AGENT = 'WorldMonitor-LocalADSB/1.0';

const BAND_LABELS = Object.freeze({ 1090: '1090 MHz', 978: '978 MHz UAT' });
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MDNS_RE = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*\.local$/;
const ICAO_RE = /^~?[0-9a-f]{6}$/;
// Docker Desktop, and compose's `host-gateway` extra_hosts entry, map this
// name to the docker host, which is where a USB receiver usually runs.
const DOCKER_HOST_NAME = 'host.docker.internal';

/**
 * Whether a dotted-quad string is loopback or RFC1918. A positive allowlist:
 * malformed input can never fall through to "allowed", and link-local
 * (169.254/16, including cloud metadata) is excluded by construction.
 * @param {string} host
 * @returns {boolean}
 */
export function isLocalIpv4(host) {
  const match = IPV4_RE.exec(String(host));
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Whether a resolved address is loopback/RFC1918 IPv4, the IPv6 loopback, or
 * an IPv4-mapped form of the former.
 * @param {string} address
 * @returns {boolean}
 */
export function isLocalReceiverAddress(address) {
  const value = String(address || '').toLowerCase();
  if (value === '::1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return isLocalIpv4(mapped ? mapped[1] : value);
}

function isAllowedFeedHost(host) {
  return host === 'localhost' || host === DOCKER_HOST_NAME || MDNS_RE.test(host) || isLocalIpv4(host);
}

function parseEntry(entry) {
  const separator = entry.indexOf('=');
  if (separator <= 0) return { band: null, reason: 'expected band=url' };
  const band = entry.slice(0, separator).trim();
  const rawUrl = entry.slice(separator + 1).trim();
  if (!LOCAL_ADSB_BANDS.includes(band)) return { band: null, reason: 'band must be 1090 or 978' };
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { band, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { band, reason: 'scheme must be http or https' };
  if (url.username || url.password) return { band, reason: 'credentials are not allowed in the URL' };
  if (url.search || url.hash || rawUrl.includes('?') || rawUrl.includes('#')) {
    return { band, reason: 'query and fragment are not allowed' };
  }
  const host = url.hostname.toLowerCase();
  if (!isAllowedFeedHost(host)) {
    return { band, reason: `host must be loopback, RFC1918, localhost, *.local or ${DOCKER_HOST_NAME}` };
  }
  if (!/(?:^|\/)aircraft\.json$/.test(url.pathname)) return { band, reason: 'path must end in aircraft.json' };
  return { band, url: url.toString() };
}

/**
 * Parse LOCAL_ADSB_FEEDS (`band=url[,band=url…]`). Labels name the band only
 * (plus an ordinal when a band repeats), so feed addresses never reach the
 * browser.
 * @param {string|undefined} value
 * @returns {{configured:boolean, feeds:Array<{id:string, band:string|null, label:string, url?:string, reason?:string}>}}
 */
export function parseLocalAdsbFeeds(value) {
  const entries = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const feeds = entries.map((entry, index) => {
    const parsed = index < MAX_FEEDS ? parseEntry(entry) : { band: null, reason: `at most ${MAX_FEEDS} feeds are read` };
    return {
      id: `feed-${index + 1}`,
      band: parsed.band,
      label: parsed.band ? BAND_LABELS[parsed.band] : `entry ${index + 1}`,
      ...(parsed.url ? { url: parsed.url } : { reason: parsed.reason }),
    };
  });
  const perBand = new Map();
  for (const feed of feeds) if (feed.band) perBand.set(feed.band, (perBand.get(feed.band) || 0) + 1);
  const seen = new Map();
  for (const feed of feeds) {
    if (!feed.band || perBand.get(feed.band) < 2) continue;
    const ordinal = (seen.get(feed.band) || 0) + 1;
    seen.set(feed.band, ordinal);
    feed.label = `${feed.label} #${ordinal}`;
  }
  return { configured: feeds.length > 0, feeds };
}

class FeedError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Resolve a feed host and require every address to be local. IP literals are
 * returned as-is (they were validated when the feed list was parsed).
 * @param {string} hostname
 * @param {typeof dnsLookup} lookupImpl
 * @returns {Promise<Array<{address:string, family:number}>>}
 */
export async function resolveLocalFeedAddresses(hostname, lookupImpl = dnsLookup) {
  if (isLocalIpv4(hostname)) return [{ address: hostname, family: 4 }];
  let resolved;
  try {
    resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new FeedError('UNRESOLVED');
  }
  const addresses = (Array.isArray(resolved) ? resolved : [resolved])
    .map((row) => ({
      address: String(row?.address || ''),
      family: Number(row?.family) || (String(row?.address).includes(':') ? 6 : 4),
    }))
    .filter((row) => row.address);
  if (!addresses.length) throw new FeedError('UNRESOLVED');
  if (addresses.some((row) => !isLocalReceiverAddress(row.address))) throw new FeedError('FORBIDDEN_ADDRESS');
  return addresses;
}

/** A `net`-style lookup that only ever answers the validated addresses. */
function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    if (options?.all) done(null, addresses.map((row) => ({ ...row })));
    else done(null, addresses[0].address, addresses[0].family);
  };
}

/**
 * Default transport: one GET over node:http(s) with the pinned lookup, a
 * fresh socket, no redirects and a streaming size cap.
 * @returns {Promise<{status:number, text:string}>}
 */
function requestFeed(url, { lookup, signal, maxBytes }) {
  const client = new URL(url).protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      lookup,
      signal,
      agent: false,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new FeedError(status >= 300 && status < 400 ? 'REDIRECT_REFUSED' : 'HTTP_STATUS'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          reject(new FeedError('RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * Fetch and parse one validated feed document.
 * @returns {Promise<object>} Parsed dump1090-style document.
 */
export async function fetchLocalFeedDocument(url, {
  requestImpl = requestFeed,
  lookupImpl = dnsLookup,
  timeoutMs = LOCAL_ADSB_TIMEOUT_MS,
  maxBytes = LOCAL_ADSB_MAX_BODY_BYTES,
} = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { hostname } = new URL(url);
    const addresses = await Promise.race([
      resolveLocalFeedAddresses(hostname, lookupImpl),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new FeedError('TIMEOUT')), { once: true })),
    ]);
    const { text } = await requestImpl(url, { lookup: pinnedLookup(addresses), signal: controller.signal, maxBytes });
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new FeedError('BAD_JSON');
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.aircraft)) throw new FeedError('BAD_DOCUMENT');
    return json;
  } catch (error) {
    controller.abort();
    if (error instanceof FeedError) throw error;
    if (error?.name === 'AbortError' || controller.signal.aborted) throw new FeedError('TIMEOUT');
    throw new FeedError('UNREACHABLE');
  } finally {
    clearTimeout(timeoutId);
  }
}

function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Normalize a dump1090/readsb/skyaware978 `aircraft.json` into records.
 * Records without a valid ICAO address or position are dropped.
 * @param {object} json
 * @param {number} documentAtMs Epoch ms the document describes.
 * @param {string} band '1090' | '978'
 */
export function normalizeDump1090Aircraft(json, documentAtMs, band) {
  if (!Array.isArray(json?.aircraft)) return [];
  const records = [];
  for (const entry of json.aircraft) {
    const icao = String(entry?.hex ?? '').trim().toLowerCase();
    if (!ICAO_RE.test(icao)) continue;
    const lat = finiteOrNull(entry.lat);
    const lon = finiteOrNull(entry.lon);
    const seenPosS = finiteOrNull(entry.seen_pos);
    if (lat === null || lon === null || seenPosS === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const onGround = entry.alt_baro === 'ground';
    const track = finiteOrNull(entry.track);
    const callsign = String(entry.flight ?? '').replace(/[^0-9A-Za-z]/g, ' ').trim().toUpperCase();
    const category = String(entry.category ?? '').trim().toUpperCase();
    records.push({
      icao,
      callsign: callsign || null,
      category: /^[A-D][0-7]$/.test(category) ? category : null,
      lat,
      lon,
      onGround,
      altitudeFt: onGround ? 0 : finiteOrNull(entry.alt_baro),
      groundSpeedKt: finiteOrNull(entry.gs),
      trackDeg: track === null ? null : Math.round((((track % 360) + 360) % 360) * 10) / 10,
      verticalRateFpm: finiteOrNull(entry.baro_rate),
      rssiDbfs: finiteOrNull(entry.rssi),
      positionAt: documentAtMs - Math.max(0, seenPosS) * 1000,
      bands: [band],
    });
  }
  return records;
}

/**
 * Merge records from several feeds by ICAO address: the newest position wins
 * and the bands that heard the aircraft are unioned.
 */
export function mergeLocalAdsbRecords(records, nowMs, maxAgeMs = LOCAL_ADSB_POSITION_MAX_AGE_MS) {
  const byIcao = new Map();
  for (const record of records) {
    if (nowMs - record.positionAt > maxAgeMs) continue;
    const existing = byIcao.get(record.icao);
    if (!existing) {
      byIcao.set(record.icao, { ...record, bands: [...record.bands] });
      continue;
    }
    const bands = [...new Set([...existing.bands, ...record.bands])].sort();
    byIcao.set(record.icao, record.positionAt > existing.positionAt ? { ...record, bands } : { ...existing, bands });
  }
  return [...byIcao.values()].map(({ positionAt, ...rest }) => ({
    ...rest,
    positionAgeS: Math.max(0, Math.round((nowMs - positionAt) / 1000)),
  }));
}

/**
 * Build the route handler. Construction parses configuration and logs invalid
 * entries once; nothing is fetched until the route is requested.
 * @returns {{handle: (req: {method?: string}) => Promise<Response>, config: object}}
 */
export function createLocalAdsbHandler({
  feedsValue = process.env[LOCAL_ADSB_FEEDS_ENV],
  requestImpl = requestFeed,
  lookupImpl = dnsLookup,
  now = Date.now,
  logger = console,
  timeoutMs = LOCAL_ADSB_TIMEOUT_MS,
  maxBytes = LOCAL_ADSB_MAX_BODY_BYTES,
  cacheMs = LOCAL_ADSB_CACHE_MS,
} = {}) {
  const config = parseLocalAdsbFeeds(feedsValue);
  for (const feed of config.feeds) {
    if (feed.reason) {
      logger.warn(`${LOG_PREFIX} ${LOCAL_ADSB_FEEDS_ENV} ${feed.id} (${feed.label}) rejected: ${feed.reason}. It will not be fetched.`);
    }
  }
  // Log a feed only when its status changes, so a feed that is down does not
  // write a line every poll.
  const lastStatus = new Map();
  const log = (feed, status, code) => {
    if (lastStatus.get(feed.id) === status) return;
    lastStatus.set(feed.id, status);
    if (status === 'live') logger.info?.(`${LOG_PREFIX} ${feed.label} live`);
    else logger.warn(`${LOG_PREFIX} ${feed.label} ${status}${code ? ` (${code})` : ''}`);
  };

  async function readFeed(feed) {
    const summary = { band: feed.band, label: feed.label };
    if (!feed.url) return { status: { ...summary, status: 'invalid', aircraft: 0, ageMs: null }, records: [] };
    let json;
    try {
      json = await fetchLocalFeedDocument(feed.url, { requestImpl, lookupImpl, timeoutMs, maxBytes });
    } catch (error) {
      log(feed, 'unreachable', error.code);
      return { status: { ...summary, status: 'unreachable', aircraft: 0, ageMs: null }, records: [] };
    }
    const receivedAt = now();
    const feedNowS = Number(json.now);
    // The feed's own clock decides staleness. A clock ahead of ours reads as
    // age 0; a document without `now` is treated as current.
    const ageMs = Number.isFinite(feedNowS) ? Math.max(0, Math.round(receivedAt - feedNowS * 1000)) : 0;
    const status = ageMs > LOCAL_ADSB_STALE_MS ? 'stale' : 'live';
    log(feed, status);
    const records = normalizeDump1090Aircraft(json, receivedAt - ageMs, feed.band);
    return { status: { ...summary, status, aircraft: records.length, ageMs }, records };
  }

  async function snapshot() {
    const results = await Promise.all(config.feeds.map(readFeed));
    const generatedAt = now();
    return {
      configured: true,
      generatedAt,
      feeds: results.map((result) => result.status),
      aircraft: mergeLocalAdsbRecords(results.flatMap((result) => result.records), generatedAt),
    };
  }

  let cached = null;
  let inFlight = null;
  async function payload() {
    if (!config.configured) return { configured: false, generatedAt: now(), feeds: [], aircraft: [] };
    if (cached && now() - cached.at < cacheMs) return cached.payload;
    if (!inFlight) {
      inFlight = snapshot().finally(() => { inFlight = null; });
    }
    const result = await inFlight;
    cached = { at: now(), payload: result };
    return result;
  }

  async function handle(req) {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (req?.method && req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });
    }
    try {
      return new Response(JSON.stringify(await payload()), { status: 200, headers });
    } catch {
      return new Response(JSON.stringify({ error: 'Local ADS-B feeds unavailable' }), { status: 502, headers });
    }
  }

  return { handle, config };
}
