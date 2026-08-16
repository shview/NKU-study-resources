import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../server/manifest-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "src", "data", "fixtures");
const outputDir = path.join(root, "dist-fixture");
const fixtureFiles = [
  "about.json",
  "feedback.json",
  "footer.json",
  "guides.json",
  "home.json",
  "links.json",
  "manifest.json",
  "participate.json",
  "reviews.json",
];
const stagedDataDir = mkdtempSync(path.join(os.tmpdir(), "nkustudy-fixtures-"));
const signalExitCodes = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
const childShutdownTimeoutMs = 5_000;

const missingFixtures = fixtureFiles.filter((name) => !existsSync(path.join(fixtureDir, name)));
if (missingFixtures.length) {
  throw new Error(`Missing reviewed fixture JSON: ${missingFixtures.join(", ")}`);
}

const unexpectedFixtures = readdirSync(fixtureDir).filter(
  (name) => name.endsWith(".json") && !fixtureFiles.includes(name),
);
if (unexpectedFixtures.length) {
  throw new Error(`Unreviewed fixture JSON is not allowed: ${unexpectedFixtures.join(", ")}`);
}

const require = createRequire(import.meta.url);
let astroPackagePath;
try {
  astroPackagePath = require.resolve("astro/package.json");
} catch {
  throw new Error("Astro is not installed. Run npm ci first.");
}

const astroPackageRoot = path.dirname(astroPackagePath);
const astroPackage = JSON.parse(readFileSync(astroPackagePath, "utf8"));
const astroBin = typeof astroPackage.bin === "string" ? astroPackage.bin : astroPackage.bin?.astro;
if (!astroBin) {
  throw new Error("The installed Astro package does not declare its CLI entry point.");
}

const astroEntry = path.resolve(astroPackageRoot, astroBin);
const astroEntryRelative = path.relative(astroPackageRoot, astroEntry);
if (astroEntryRelative.startsWith("..") || path.isAbsolute(astroEntryRelative) || !existsSync(astroEntry)) {
  throw new Error("The installed Astro CLI entry point is invalid.");
}

let cleaned = false;
function cleanupStagedFixtures() {
  if (cleaned) return;
  cleaned = true;
  rmSync(stagedDataDir, { recursive: true, force: true });
}

process.once("exit", cleanupStagedFixtures);

let activeChild;
let receivedSignal;
let forceKillTimer;
let testSignalTimer;

function stopForceKillTimer() {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  forceKillTimer = undefined;
}

function forwardSignalToChild(signal) {
  if (!activeChild || activeChild.exitCode !== null || activeChild.signalCode !== null) return;

  try {
    activeChild.kill(signal);
  } catch {
    // Some platforms do not implement every POSIX signal. SIGTERM is the safe fallback.
    activeChild.kill("SIGTERM");
  }

  stopForceKillTimer();
  forceKillTimer = setTimeout(() => {
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill("SIGKILL");
    }
  }, childShutdownTimeoutMs);
}

function handleSignal(signal) {
  if (receivedSignal) {
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill("SIGKILL");
    }
    return;
  }

  receivedSignal = signal;
  forwardSignalToChild(signal);
}

const signalHandlers = new Map(
  [...signalExitCodes.keys()].map((signal) => [signal, () => handleSignal(signal)]),
);
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

function getBuildCommand() {
  const testCommand = process.env.NKUSTUDY_FIXTURE_BUILD_TEST_COMMAND;
  if (testCommand === undefined) {
    return { command: process.execPath, args: [astroEntry, "build", "--outDir", outputDir] };
  }

  if (process.env.NODE_ENV !== "test" || process.env.NKUSTUDY_FIXTURE_BUILD_TEST_HOOK !== "1") {
    throw new Error("The fixture-build child override is available only to the isolated test harness.");
  }

  let parts;
  try {
    parts = JSON.parse(testCommand);
  } catch {
    throw new Error("NKUSTUDY_FIXTURE_BUILD_TEST_COMMAND must be a JSON string array.");
  }
  if (!Array.isArray(parts) || !parts.length || parts.some((part) => typeof part !== "string" || !part)) {
    throw new Error("NKUSTUDY_FIXTURE_BUILD_TEST_COMMAND must contain a command and optional arguments.");
  }
  return { command: parts[0], args: parts.slice(1) };
}

function getTestSignal() {
  const testSignal = process.env.NKUSTUDY_FIXTURE_BUILD_TEST_SIGNAL;
  if (testSignal === undefined) return undefined;
  if (
    process.env.NODE_ENV !== "test"
    || process.env.NKUSTUDY_FIXTURE_BUILD_TEST_HOOK !== "1"
    || !signalExitCodes.has(testSignal)
  ) {
    throw new Error("The fixture-build signal hook is available only to the isolated test harness.");
  }
  return testSignal;
}

function runAstroBuild() {
  return new Promise((resolve, reject) => {
    const { command, args } = getBuildCommand();
    const testSignal = getTestSignal();
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, DATA_DIR: stagedDataDir, NODE_ENV: "test", NKUSTUDY_FIXTURE_BUILD: "1" },
      stdio: "inherit",
    });
    activeChild = child;

    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));

    // A signal could be queued while the synchronous fixture staging was running.
    if (receivedSignal) forwardSignalToChild(receivedSignal);

    // Windows cannot deliver catchable POSIX signals to a child process. This
    // explicitly gated hook lets the cross-platform test exercise the same handler.
    if (testSignal !== undefined) {
      testSignalTimer = setTimeout(() => handleSignal(testSignal), 100);
    }
  });
}

rmSync(outputDir, { recursive: true, force: true });

try {
  for (const name of fixtureFiles) {
    const destination = path.join(stagedDataDir, name);
    copyFileSync(path.join(fixtureDir, name), destination, constants.COPYFILE_EXCL);
  }

  const manifestErrors = validateManifest(JSON.parse(readFileSync(path.join(stagedDataDir, "manifest.json"), "utf8")));
  if (manifestErrors.length) throw new Error(`Fixture manifest is invalid:\n${manifestErrors.join("\n")}`);

  const result = await runAstroBuild();
  if (receivedSignal) {
    // Node has no portable way to re-raise all POSIX signals on Windows. Preserve
    // conventional shell exit codes consistently across supported platforms.
    process.exitCode = signalExitCodes.get(receivedSignal) ?? 1;
  } else if (result.signal) {
    process.exitCode = signalExitCodes.get(result.signal) ?? 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} finally {
  stopForceKillTimer();
  if (testSignalTimer) clearTimeout(testSignalTimer);
  activeChild = undefined;
  cleanupStagedFixtures();
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
