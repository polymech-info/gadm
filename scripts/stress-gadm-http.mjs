/**
 * Stress harness for `boundaries serve` (llm-server stress spirit).
 *
 *   node scripts/stress-gadm-http.mjs --base http://127.0.0.1:3340
 *   node scripts/stress-gadm-http.mjs --base http://127.0.0.1:3340 --levels 1,10,25 --gid ESP --level 0
 *
 * Flags:
 *   --base <url>           gadm-http base (default http://127.0.0.1:3340)
 *   --levels <csv>         concurrent client ramp (default 1,5,10,25)
 *   --gid <gid>            boundary probe (default ESP)
 *   --level <n>            boundary admin level (default 0)
 *   --req-timeout-ms <n>   per-request abort (default 60000)
 *   --viewport             also hit in-viewport (Spain-ish bbox L2)
 */
import { performance } from 'node:perf_hooks';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const BASE = (arg('--base', 'http://127.0.0.1:3340') || '').replace(/\/$/, '');
const LEVELS = (arg('--levels', '1,5,10,25') || '')
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const GID = arg('--gid', 'ESP');
const LEVEL = Number.parseInt(arg('--level', '0'), 10) || 0;
const TIMEOUT = Number.parseInt(arg('--req-timeout-ms', '60000'), 10) || 60_000;
const DO_VIEWPORT = process.argv.includes('--viewport');
const DO_HIERARCHY = process.argv.includes('--hierarchy');
const DO_SEARCH = process.argv.includes('--search');
const LAT = Number.parseFloat(arg('--lat', '40.4168'));
const LON = Number.parseFloat(arg('--lon', '-3.7038'));
const SEARCH_Q = arg('--q', 'Madrid');

async function one(url) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const buf = await res.arrayBuffer();
    return {
      ok: res.ok,
      status: res.status,
      ms: performance.now() - t0,
      bytes: buf.byteLength,
    };
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - t0, bytes: 0, err: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function burst(n, factory) {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: n }, () => factory()));
  const wall = performance.now() - started;
  const oks = results.filter((r) => r.ok);
  const fails = results.length - oks.length;
  const ms = oks.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = ms[Math.floor(ms.length * 0.5)] ?? 0;
  const p95 = ms[Math.floor(ms.length * 0.95)] ?? 0;
  const bytes = oks.reduce((a, r) => a + r.bytes, 0);
  return { n, wall, fails, p50, p95, bytes, sampleErr: results.find((r) => !r.ok)?.err };
}

async function main() {
  console.log(`stress-gadm-http base=${BASE} levels=${LEVELS.join(',')} gid=${GID} L${LEVEL}`);

  const health = await one(`${BASE}/health`);
  if (!health.ok) {
    console.error(`health failed status=${health.status} err=${health.err || ''} — start: boundaries serve --port 3340`);
    process.exit(1);
  }
  console.log(`health ok ${health.ms.toFixed(0)}ms`);

  const boundaryUrl = `${BASE}/v1/regions/boundary/${encodeURIComponent(GID)}?level=${LEVEL}&map=1`;
  const viewportUrl =
    `${BASE}/v1/regions/in-viewport?minLng=-3.87&minLat=39.42&maxLng=-3.25&maxLat=39.74&level=2`;
  const hierarchyUrl = `${BASE}/v1/regions/hierarchy?lat=${LAT}&lon=${LON}`;
  const searchUrl = `${BASE}/v1/regions/search?query=${encodeURIComponent(SEARCH_Q)}`;
  const namesUrl = `${BASE}/v1/regions/names?admin=${encodeURIComponent(GID)}&depth=1`;

  // Smoke new geom/metadata routes once
  for (const [label, url] of [
    ['hierarchy', hierarchyUrl],
    ['search', searchUrl],
    ['names', namesUrl],
  ]) {
    const r = await one(url);
    console.log(`${label} smoke: status=${r.status} ${r.ms.toFixed(0)}ms bytes=${r.bytes}` + (r.err ? ` err=${r.err}` : ''));
  }

  for (const n of LEVELS) {
    const b = await burst(n, () => one(boundaryUrl));
    console.log(
      `boundary x${n}: wall=${b.wall.toFixed(0)}ms p50=${b.p50.toFixed(0)}ms p95=${b.p95.toFixed(0)}ms ` +
        `fail=${b.fails} bytes=${b.bytes}` +
        (b.sampleErr ? ` err=${b.sampleErr}` : ''),
    );
    if (DO_VIEWPORT) {
      const v = await burst(n, () => one(viewportUrl));
      console.log(
        `viewport x${n}: wall=${v.wall.toFixed(0)}ms p50=${v.p50.toFixed(0)}ms p95=${v.p95.toFixed(0)}ms ` +
          `fail=${v.fails}` +
          (v.sampleErr ? ` err=${v.sampleErr}` : ''),
      );
    }
    if (DO_HIERARCHY) {
      const h = await burst(n, () => one(hierarchyUrl));
      console.log(
        `hierarchy x${n}: wall=${h.wall.toFixed(0)}ms p50=${h.p50.toFixed(0)}ms p95=${h.p95.toFixed(0)}ms fail=${h.fails}`,
      );
    }
    if (DO_SEARCH) {
      const s = await burst(n, () => one(searchUrl));
      console.log(
        `search x${n}: wall=${s.wall.toFixed(0)}ms p50=${s.p50.toFixed(0)}ms p95=${s.p95.toFixed(0)}ms fail=${s.fails}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
