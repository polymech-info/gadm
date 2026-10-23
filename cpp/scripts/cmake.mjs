#!/usr/bin/env node
/**
 * Thin cmake wrapper — injects MSVC env (vs-env) + VCPKG_ROOT (ensure-vcpkg).
 * Ported from pixlwiz/scripts/cmake.mjs; cwd is always packages/gadm/cpp.
 *
 *   node cpp/scripts/cmake.mjs --preset release
 *   node cpp/scripts/cmake.mjs --build --preset release --target boundaries
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getVsEnv } from "./vs-env.mjs";
import { ensureVcpkgRoot } from "./ensure-vcpkg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cppRoot = resolve(__dirname, "..");

const exe =
  process.env.POLYMECH_CMAKE ||
  (process.platform === "linux" && existsSync("/snap/bin/cmake")
    ? "/snap/bin/cmake"
    : "cmake");

const vsEnv = getVsEnv();
const env = { ...(vsEnv || process.env) };
try {
  env.VCPKG_ROOT = ensureVcpkgRoot();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}

const args = process.argv.slice(2);
console.log(`[cmake] ${[exe, ...args].join(" ")}`);
console.log(`[cmake] cwd=${cppRoot}`);
console.log(`[cmake] VCPKG_ROOT=${env.VCPKG_ROOT}`);

const r = spawnSync(exe, args, {
  cwd: cppRoot,
  stdio: "inherit",
  env,
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
