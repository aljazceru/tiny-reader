/* Release packaging: dist/tiny-reader-{firefox,chrome,source}-<version>.zip.
 * The Firefox zip holds the shared tree at its root, the Chrome zip comes
 * from the store build (no key), the source zip is the git-tracked files. */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "../vendor/fflate.js";

const root = new URL("..", import.meta.url);
const version = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")).version;
const zip = (name) => unzipSync(readFileSync(new URL(`dist/${name}`, root)));

before(() => {
  execFileSync(process.execPath, [new URL("tools/package.mjs", root).pathname]);
});

test("package.mjs produces the Firefox, Chrome and source zips", () => {
  for (const channel of ["firefox", "chrome", "source"]) {
    assert.ok(existsSync(new URL(`dist/tiny-reader-${channel}-${version}.zip`, root)),
      `tiny-reader-${channel}-${version}.zip missing`);
  }
});

test("the Firefox zip holds the extension tree at its root", () => {
  const files = zip(`tiny-reader-firefox-${version}.zip`);
  for (const name of ["manifest.json", "welcome/welcome.html", "compat/compat.js"]) {
    assert.ok(name in files, `${name} missing from the Firefox zip`);
  }
  for (const name of Object.keys(files)) {
    assert.ok(!name.startsWith("tools/") && !name.startsWith("test/"), `${name} should not ship`);
  }
});

test("the Chrome zip manifest has no extension key", () => {
  const files = zip(`tiny-reader-chrome-${version}.zip`);
  assert.ok("manifest.json" in files, "manifest.json missing from the Chrome zip");
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  assert.equal(manifest.key, undefined, "key leaked into the Chrome zip");
});
