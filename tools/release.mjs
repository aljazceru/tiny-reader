/*
 * tiny reader — release pipeline.
 *
 *   node tools/release.mjs
 *
 * Runs the release steps in order, each with stdio inherited, and stops
 * at the first failure naming the step:
 *
 *   node --test → web-ext lint → build-chrome → build-chrome --store →
 *   smoke → package
 *
 * web-ext lint runs on the repo root with dist/, tools/, test/, docs/
 * and .superpowers/ ignored so the shipped tree is what gets checked;
 * warnings stay warnings but errors exit nonzero. On success dist/
 * holds the firefox, chrome and source zips plus the built trees.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

const STEPS = [
  ["node --test", [node, ["--test"]]],
  ["web-ext lint", ["npx", ["--yes", "web-ext", "lint", "--source-dir", ".",
    "--ignore-files", "dist/**", "tools/**", "test/**", "docs/**", ".superpowers/**"]]],
  ["build-chrome", [node, ["tools/build-chrome.mjs"]]],
  ["build-chrome --store", [node, ["tools/build-chrome.mjs", "--store"]]],
  ["smoke", [node, ["tools/smoke.mjs"]]],
  ["package", [node, ["tools/package.mjs"]]],
];

for (const [name, [command, args]] of STEPS) {
  console.log(`\n=== ${name} ===`);
  const { status, error } = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (error || status !== 0) {
    console.error(`\nrelease: FAILED at ${name}`);
    process.exit(error ? 1 : status);
  }
}
console.log("\nrelease: all steps passed");
