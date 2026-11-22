/*
 * tiny reader — release packages.
 *
 *   node tools/package.mjs
 *
 * Writes dist/tiny-reader-firefox-<version>.zip (shared tree at the
 * archive root), dist/tiny-reader-chrome-<version>.zip (the --store
 * build, no extension key) and dist/tiny-reader-source-<version>.zip
 * (the git-tracked files) into dist/. Version comes from manifest.json.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "../vendor/fflate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const FIREFOX_FILES = [
  "manifest.json", "background", "engine", "vendor", "content", "popup",
  "reader", "welcome", "logic", "compat", "icons", "assets", "LICENSE", "NOTICE",
];

/* All files under dir, recursively. */
function filesOf(dir) {
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dir);
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const version = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version;

  // Firefox: the shared tree, paths at the archive root.
  const firefox = {};
  for (const entry of FIREFOX_FILES) {
    const source = join(root, entry);
    if (statSync(source).isDirectory()) {
      for (const file of filesOf(source)) firefox[relative(root, file)] = readFileSync(file);
    } else firefox[entry] = readFileSync(source);
  }

  // Chrome: the store build (no key), paths at the archive root.
  execFileSync(process.execPath, [join(root, "tools", "build-chrome.mjs"), "--store"]);
  const chromeStore = join(dist, "chrome-store");
  const chrome = {};
  for (const file of filesOf(chromeStore)) chrome[relative(chromeStore, file)] = readFileSync(file);

  // Source: everything git tracks (.gitignore keeps out dist/, .superpowers/).
  const source = {};
  for (const name of execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n")) {
    source[name] = readFileSync(join(root, name));
  }

  for (const [channel, files] of [["firefox", firefox], ["chrome", chrome], ["source", source]]) {
    const path = join(dist, `tiny-reader-${channel}-${version}.zip`);
    writeFileSync(path, zipSync(files));
    console.log(`package: ${path}`);
  }
}
