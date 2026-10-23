#!/usr/bin/env node
/**
 * Emulate MapLibre pan / zoom-prefetch against GADM HTTP (or Node proxy).
 *
 * Realistic EU scenario:
 *   1. Lazy-start `boundaries serve` if /health is down
 *   2. Pan a sequence of EU viewports at L0 → fetch each visible boundary + neighbors
 *   3. Drop into L1 / L2 for Spain/France tiles and re-check (hole detection)
 *
 *   node scripts/pan-boundaries.mjs
 *   node scripts/pan-boundaries.mjs --base http://127.0.0.1:3340
 *   node scripts/pan-boundaries.mjs --via-node --node http://localhost:3333
 *   node scripts/pan-boundaries.mjs --debug --timeout-ms 20000
 *
 * Exit 0 = all critical checks passed; 1 = failures (holes / hang / 5xx).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GADM_PKG = resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}
function flag(name) {
  return process.argv.includes(name);
}

const VIA_NODE = flag('--via-node');
const DEBUG = flag('--debug') || flag('-v');
const NO_SPAWN = flag('--no-spawn');
const BASE_CPP = (arg('--base', 'http://127.0.0.1:3340') || '').replace(/\/$/, '');
const NODE_BASE = (arg('--node', 'http://localhost:3333') || '').replace(/\/$/, '');
const TIMEOUT = Number.parseInt(arg('--timeout-ms', '25000'), 10) || 25_000;
const HOST = arg('--host', '127.0.0.1');
const PORT = Number.parseInt(arg('--port', '3340'), 10) || 3340;

const log = (...a) => console.log('[pan]', ...a);
const dbg = (...a) => {
  if (DEBUG) console.log('[pan:debug]', ...a);
};

/** EU pan steps — west→east then south→north, mimicking hover prefetch tiles. */
const EU_L0_PANS = [
  { name: 'iberia', minLng: -10.5, minLat: 35.5, maxLng: 4.5, maxLat: 44.5 },
  { name: 'france-benelux', minLng: -5.5, minLat: 41.5, maxLng: 8.5, maxLat: 51.5 },
  { name: 'central', minLng: 4, minLat: 44, maxLng: 18, maxLat: 55 },
  { name: 'italy-balkans', minLng: 6, minLat: 36, maxLng: 22, maxLat: 48 },
  { name: 'nordics', minLng: 4, minLat: 54, maxLng: 30, maxLat: 71 },
  { name: 'uk-ie', minLng: -11, minLat: 49, maxLng: 2, maxLat: 61 },
];

/** Finer zoom over Spain after L0 settle. */
const ES_FINER = [
  { level: 1, name: 'es-l1', minLng: -9.5, minLat: 35.9, maxLng: 4.5, maxLat: 43.9 },
  { level: 2, name: 'es-l2-madrid', minLng: -4.2, minLat: 39.8, maxLng: -3.2, maxLat: 40.8 },
];

let child = null;

function exePath() {
  const name = IS_WIN ? 'boundaries.exe' : 'boundaries';
  return join(GADM_PKG, 'dist', IS_WIN ? 'win-x64' : 'linux-x64', name);
}

async function fetchJson(url, { timeoutMs = TIMEOUT } = {}) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* binary / non-json */
    }
    return {
      ok: res.ok,
      status: res.status,
      ms,
      bytes: text.length,
      json,
      textHead: text.slice(0, 120),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - t0,
      bytes: 0,
      err: String(e?.name === 'AbortError' ? `timeout>${timeoutMs}ms` : e?.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function urlBoundary(gid, level, { map = true, enrich = false } = {}) {
  if (VIA_NODE) {
    let u = `${NODE_BASE}/api/regions/boundary/${encodeURIComponent(gid)}?targetLevel=${level}`;
    if (map) u += '&simplify=map';
    if (enrich) u += '&enrich=true';
    return u;
  }
  return `${BASE_CPP}/v1/regions/boundary/${encodeURIComponent(gid)}?level=${level}${map ? '&map=1' : ''}`;
}

function urlNeighbors(gid, level) {
  if (VIA_NODE) {
    return `${NODE_BASE}/api/regions/neighbors?gid=${encodeURIComponent(gid)}&level=${level}`;
  }
  return `${BASE_CPP}/v1/regions/neighbors?gid=${encodeURIComponent(gid)}&level=${level}`;
}

function urlViewport(bbox, level) {
  const q = `minLng=${bbox.minLng}&minLat=${bbox.minLat}&maxLng=${bbox.maxLng}&maxLat=${bbox.maxLat}&level=${level}`;
  if (VIA_NODE) return `${NODE_BASE}/api/regions/in-viewport?${q}`;
  return `${BASE_CPP}/v1/regions/in-viewport?${q}`;
}

function healthUrl() {
  return VIA_NODE ? `${NODE_BASE}/api/system-info` : `${BASE_CPP}/health`;
}

async function waitHealth(tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await fetchJson(VIA_NODE ? `${BASE_CPP}/health` : healthUrl(), { timeoutMs: 2000 });
    if (r.ok) return true;
    await new Promise((x) => setTimeout(x, 250));
  }
  return false;
}

async function ensureBoundaries() {
  const already = await fetchJson(`${BASE_CPP}/health`, { timeoutMs: 1500 });
  if (already.ok) {
    log(`boundaries already up (${already.ms.toFixed(0)}ms)`);
    return true;
  }
  if (NO_SPAWN) {
    log('boundaries down and --no-spawn set');
    return false;
  }
  const exe = exePath();
  if (!existsSync(exe)) {
    log(`missing binary: ${exe}`);
    return false;
  }
  const cacheDir = join(GADM_PKG, 'cache', 'gadm');
  const gpkg = join(GADM_PKG, 'data', 'gadm_410.gpkg');
  const argv = [
    'serve',
    '--host',
    HOST,
    '--port',
    String(PORT),
    '--cache-dir',
    cacheDir,
    '--gpkg',
    gpkg,
  ];
  log(`spawning ${exe} ${argv.join(' ')}`);
  child = spawn(exe, argv, {
    cwd: GADM_PKG,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      // Stress mode: keep validators but allow long queries
      GADM_HTTP_STRESS: '1',
    },
  });
  child.stdout?.on('data', (b) => dbg('stdout', b.toString('utf8').trim().slice(0, 200)));
  child.stderr?.on('data', (b) => dbg('stderr', b.toString('utf8').trim().slice(0, 200)));
  child.on('exit', (code, signal) => log(`boundaries exited code=${code} signal=${signal}`));
  const ok = await waitHealth();
  if (!ok) log('boundaries failed to become healthy');
  else log('boundaries ready');
  return ok;
}

/**
 * Hole / paint-quality heuristics on a FeatureCollection (or C++ raw JSON).
 * Returns list of issue strings (empty = ok).
 */
function inspectBoundary(gid, level, body) {
  const issues = [];
  if (!body) {
    issues.push('empty-body');
    return issues;
  }
  if (body.error) {
    issues.push(`error:${body.error}`);
    return issues;
  }
  const features = body.features || body.data?.features || (Array.isArray(body) ? body : null);
  if (!features) {
    // C++ may stream a FeatureCollection as the whole body — already parsed
    if (body.type === 'FeatureCollection' && Array.isArray(body.features)) {
      return inspectBoundary(gid, level, body);
    }
    issues.push('no-features-key');
    return issues;
  }
  if (features.length === 0) {
    issues.push('zero-features');
    return issues;
  }
  let rings = 0;
  let emptyGeom = 0;
  let noCoords = 0;
  for (const f of features) {
    const g = f?.geometry;
    if (!g) {
      emptyGeom++;
      continue;
    }
    const coords = g.coordinates;
    if (!coords || !coords.length) {
      noCoords++;
      continue;
    }
    if (g.type === 'Polygon') rings += coords.length;
    else if (g.type === 'MultiPolygon') {
      for (const poly of coords) rings += poly?.length || 0;
    }
  }
  if (emptyGeom === features.length) issues.push('all-empty-geom');
  if (noCoords > 0) issues.push(`no-coords:${noCoords}`);
  if (rings === 0 && features.length > 0) issues.push('no-rings');
  // L0 countries should usually have an outer ring; holes (inner rings) are OK.
  dbg(`${gid} L${level}: features=${features.length} rings=${rings} emptyGeom=${emptyGeom}`);
  return issues;
}

async function fetchVisibleAtLevel(bbox, level, { maxGids = 40 } = {}) {
  const vUrl = urlViewport(bbox, level);
  dbg('GET', vUrl);
  const v = await fetchJson(vUrl);
  if (!v.ok) {
    return { viewport: v, gids: [], results: [], fail: `viewport ${v.status} ${v.err || ''}` };
  }
  const rows = v.json?.data || v.json?.features || [];
  const gids = [];
  for (const r of rows) {
    const gid = r.gid || r.properties?.GID_0 || r.properties?.gid;
    if (gid && !gids.includes(gid)) gids.push(gid);
    if (gids.length >= maxGids) break;
  }
  log(`  viewport ${bbox.name || ''} L${level}: ${gids.length} gids (${v.ms.toFixed(0)}ms) → ${gids.slice(0, 8).join(',')}${gids.length > 8 ? '…' : ''}`);

  const results = [];
  for (const gid of gids) {
    const bUrl = urlBoundary(gid, level, { map: true, enrich: false });
    dbg('GET', bUrl);
    const b = await fetchJson(bUrl);
    const issues = b.ok ? inspectBoundary(gid, level, b.json) : [`http-${b.status}:${b.err || b.textHead}`];
    const nUrl = urlNeighbors(gid, level);
    dbg('GET', nUrl);
    const n = await fetchJson(nUrl, { timeoutMs: Math.min(TIMEOUT, 45_000) });
    const nOk = n.ok && !n.json?.error;
    results.push({
      gid,
      boundaryMs: b.ms,
      boundaryOk: b.ok && issues.length === 0,
      boundaryBytes: b.bytes,
      issues,
      neighborsOk: nOk,
      neighborsMs: n.ms,
      neighborCount: n.json?.data?.length ?? n.json?.neighbors?.length ?? null,
    });
    if (!b.ok || issues.length) {
      log(`  ✗ boundary ${gid} L${level}: status=${b.status} ${b.ms.toFixed(0)}ms issues=${issues.join(',') || '-'} err=${b.err || ''}`);
    } else {
      dbg(`  ✓ boundary ${gid} L${level}: ${b.ms.toFixed(0)}ms ${b.bytes}B`);
    }
    if (!nOk) {
      log(`  ✗ neighbors ${gid} L${level}: status=${n.status} ${n.ms.toFixed(0)}ms err=${n.err || n.json?.error || ''}`);
    }
  }
  return { viewport: v, gids, results };
}

async function main() {
  log(`mode=${VIA_NODE ? 'node-proxy' : 'cpp-direct'} cpp=${BASE_CPP} node=${NODE_BASE} timeout=${TIMEOUT}ms`);
  const up = await ensureBoundaries();
  if (!up) {
    process.exitCode = 1;
    return;
  }

  // Smoke ETH — the hang case that started this.
  log('smoke ETH L0 boundary+neighbors (enrich skipped — map path)');
  for (const enrich of [false, true]) {
    const u = urlBoundary('ETH', 0, { map: true, enrich });
    const r = await fetchJson(u);
    const issues = r.ok ? inspectBoundary('ETH', 0, r.json) : [`http-${r.status}`];
    log(
      `  ETH enrich=${enrich}: status=${r.status} ${r.ms.toFixed(0)}ms bytes=${r.bytes} issues=${issues.join(',') || 'none'}` +
        (r.err ? ` err=${r.err}` : ''),
    );
    if (enrich && r.ms > 15_000) {
      log('  ✗ enrich=true path still too slow — server must stay on C++');
      process.exitCode = 1;
    }
  }
  {
    const n = await fetchJson(urlNeighbors('ETH', 0));
    log(`  ETH neighbors: status=${n.status} ${n.ms.toFixed(0)}ms` + (n.err ? ` err=${n.err}` : ''));
  }

  let failCount = 0;
  let holeCount = 0;
  let hangCount = 0;

  log('── EU L0 pan sequence ──');
  for (const bbox of EU_L0_PANS) {
    log(`pan ${bbox.name}`);
    const { results, fail } = await fetchVisibleAtLevel(bbox, 0, { maxGids: 35 });
    if (fail) {
      log(`  ✗ ${fail}`);
      failCount++;
      continue;
    }
    for (const r of results) {
      if (r.boundaryMs >= TIMEOUT * 0.9) hangCount++;
      if (!r.boundaryOk) {
        failCount++;
        if (r.issues.some((i) => /zero-features|no-rings|all-empty|no-features/.test(i))) holeCount++;
      }
      if (!r.neighborsOk) failCount++;
    }
  }

  log('── ES finer levels ──');
  for (const step of ES_FINER) {
    log(`zoom ${step.name} L${step.level}`);
    const { results, fail } = await fetchVisibleAtLevel(step, step.level, { maxGids: 25 });
    if (fail) {
      log(`  ✗ ${fail}`);
      failCount++;
      continue;
    }
    for (const r of results) {
      if (r.boundaryMs >= TIMEOUT * 0.9) hangCount++;
      if (!r.boundaryOk) {
        failCount++;
        if (r.issues.some((i) => /zero-features|no-rings|all-empty|no-features/.test(i))) holeCount++;
      }
    }
  }

  log('── summary ──');
  log(`fails=${failCount} holes=${holeCount} hangs≈${hangCount}`);
  if (failCount > 0 || hangCount > 0) process.exitCode = 1;
  else log('OK');
}

function shutdown() {
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    child = null;
  }
}
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    // Spawned boundaries keeps stdio open — kill + hard-exit or npm stays alive → exit 1 later.
    shutdown();
    process.exit(process.exitCode ?? 0);
  });
