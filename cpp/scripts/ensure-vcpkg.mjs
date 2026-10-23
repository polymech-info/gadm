/**
 * Ensure VCPKG_ROOT points at a usable vcpkg tree (toolchain file present).
 * Prefers existing env / common paths; otherwise clones a shallow copy under cpp/.vcpkg
 * so manifest mode can reuse ./vcpkg_installed (GDAL/GEOS/PROJ already built).
 */
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cppRoot = resolve(__dirname, "..");
const localVcpkg = resolve(cppRoot, ".vcpkg");

function toolchainOk(root) {
  return root && existsSync(resolve(root, "scripts/buildsystems/vcpkg.cmake"));
}

function candidateRoots() {
  return [
    process.env.VCPKG_ROOT,
    localVcpkg,
    "C:\\Users\\zx\\Desktop\\tests\\vcpkg",
    resolve(process.env.USERPROFILE || "", "vcpkg"),
    "C:\\vcpkg",
    "C:\\src\\vcpkg",
  ].filter(Boolean);
}

function bootstrap(root) {
  const bat = resolve(root, "bootstrap-vcpkg.bat");
  const sh = resolve(root, "bootstrap-vcpkg.sh");
  if (process.platform === "win32" && existsSync(bat)) {
    console.log(`[vcpkg] bootstrapping ${root}`);
    // Quote path in one shell string — avoid DEP0190 (args + shell:true).
    const r = spawnSync(`"${bat}" -disableMetrics`, {
      cwd: root,
      stdio: "inherit",
      shell: true,
    });
    return r.status === 0;
  }
  if (existsSync(sh)) {
    console.log(`[vcpkg] bootstrapping ${root}`);
    const r = spawnSync("sh", [sh, "-disableMetrics"], {
      cwd: root,
      stdio: "inherit",
    });
    return r.status === 0;
  }
  return false;
}

function cloneLocal() {
  mkdirSync(cppRoot, { recursive: true });
  if (existsSync(localVcpkg)) return toolchainOk(localVcpkg);
  console.log(`[vcpkg] cloning shallow → ${localVcpkg}`);
  const r = spawnSync(
    "git",
    ["clone", "--depth", "1", "https://github.com/microsoft/vcpkg.git", localVcpkg],
    { stdio: "inherit" },
  );
  if (r.status !== 0) return false;
  return bootstrap(localVcpkg);
}

/** @returns {string} absolute VCPKG_ROOT */
export function ensureVcpkgRoot() {
  for (const root of candidateRoots()) {
    if (toolchainOk(root)) {
      if (root === process.env.VCPKG_ROOT) return root;
      console.log(`[vcpkg] using ${root}`);
      return root;
    }
  }

  // Stale VCPKG_ROOT in env — ignore and recover.
  if (process.env.VCPKG_ROOT) {
    console.warn(
      `[vcpkg] VCPKG_ROOT=${process.env.VCPKG_ROOT} missing toolchain — recovering`,
    );
  }

  if (!cloneLocal() || !toolchainOk(localVcpkg)) {
    throw new Error(
      "[vcpkg] could not find or bootstrap vcpkg — set VCPKG_ROOT or install git",
    );
  }
  return localVcpkg;
}

// CLI: node cpp/scripts/ensure-vcpkg.mjs
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/ensure-vcpkg.mjs");
if (isMain) {
  try {
    const root = ensureVcpkgRoot();
    console.log(`[vcpkg] VCPKG_ROOT=${root}`);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
