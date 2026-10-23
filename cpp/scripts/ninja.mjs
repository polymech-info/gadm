#!/usr/bin/env node
/**
 * Thin ninja wrapper that injects the MSVC VS environment (same as cmake.mjs).
 * Ported from pixlwiz/scripts/ninja.mjs — skips version bake / UI kill (gadm has none).
 *
 *   node cpp/scripts/ninja.mjs --preset release
 *   node cpp/scripts/ninja.mjs --preset release --target boundaries -- -j 8
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getVsEnv } from "./vs-env.mjs";
import { ensureVcpkgRoot } from "./ensure-vcpkg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cppRoot = resolve(__dirname, "..");

/** Leave two cores for the desktop; 16c → -j 14 -l 14. */
function cpuCount() {
  return cpus()?.length || 8;
}

function ninjaHasFlag(args, flag) {
  return args.some(
    (a) => a === flag || (a.startsWith(flag) && /^[\d.]/.test(a.slice(flag.length))),
  );
}

function defaultNinjaJobs() {
  return Math.max(1, cpuCount() - 2);
}

function withDefaultNinjaLimits(args) {
  const extra = [];
  const jobs = defaultNinjaJobs();
  if (!ninjaHasFlag(args, "-j")) extra.push("-j", String(jobs));
  if (!ninjaHasFlag(args, "-l")) extra.push("-l", String(jobs));
  return extra.length ? [...extra, ...args] : args;
}

function resolveBinaryDir(presets, presetName, seen = new Set()) {
  if (!presetName || seen.has(presetName)) return null;
  seen.add(presetName);

  const build = (presets.buildPresets || []).find((p) => p.name === presetName);
  if (build?.binaryDir) return build.binaryDir;
  if (build?.configurePreset) {
    const fromConf = resolveBinaryDir(presets, build.configurePreset, seen);
    if (fromConf) return fromConf;
  }

  const conf = (presets.configurePresets || []).find((p) => p.name === presetName);
  if (conf?.binaryDir) return conf.binaryDir;
  if (conf?.inherits) {
    const parents = Array.isArray(conf.inherits) ? conf.inherits : [conf.inherits];
    for (const parent of parents) {
      const fromParent = resolveBinaryDir(presets, parent, seen);
      if (fromParent) return fromParent;
    }
  }
  return null;
}

function getBuildDir(presetName) {
  const presetsFile = resolve(cppRoot, "CMakePresets.json");
  if (existsSync(presetsFile)) {
    try {
      const presets = JSON.parse(readFileSync(presetsFile, "utf8"));
      const binaryDir = resolveBinaryDir(presets, presetName);
      if (binaryDir) {
        return binaryDir
          .replaceAll("${sourceDir}", cppRoot)
          .replaceAll("${presetName}", presetName);
      }
    } catch {
      /* fall through */
    }
  }
  return resolve(cppRoot, "build");
}

const args = process.argv.slice(2);
const presetIdx = args.indexOf("--preset");
const preset = presetIdx >= 0 ? args[presetIdx + 1] : "release";

const targetIdx = args.indexOf("--target");
const target = targetIdx >= 0 ? args[targetIdx + 1] : null;

const sepIdx = args.indexOf("--");
const ninjaArgs = withDefaultNinjaLimits([
  ...(sepIdx >= 0 ? args.slice(sepIdx + 1) : []),
  ...(target ? [target] : []),
]);

const buildDir = getBuildDir(preset);
if (!existsSync(buildDir)) {
  console.error(`[ninja] build dir not found: ${buildDir}`);
  console.error("[ninja] Run configure first: npm run configure:cpp");
  process.exit(1);
}
if (!existsSync(resolve(buildDir, "build.ninja"))) {
  console.error(`[ninja] no build.ninja in ${buildDir} (need Ninja generator preset)`);
  console.error("[ninja] Run: npm run configure:cpp");
  process.exit(1);
}

const vsEnv = getVsEnv();
const env = { ...(vsEnv || process.env) };
try {
  env.VCPKG_ROOT = ensureVcpkgRoot();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}

console.log(`[ninja] ${["ninja", ...ninjaArgs].join(" ")}`);
console.log(`[ninja] cwd=${buildDir}`);
const r = spawnSync("ninja", ninjaArgs, {
  cwd: buildDir,
  stdio: "inherit",
  env,
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
