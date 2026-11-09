// Release helper for .github/workflows/release.yml.
// Usage: node scripts/release-notes.mjs <version>
// Checks that package.json, Cargo.toml and tauri.conf.json carry <version>,
// then prints `name` and `body` for $GITHUB_OUTPUT from CHANGELOG.md.
// Fails when the changelog has no section (in English and German) for it.
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) fail("usage: release-notes.mjs <version>");

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const found = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  "src-tauri/Cargo.toml": /^version\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))?.[1],
};
for (const [file, v] of Object.entries(found)) {
  if (v !== version) fail(`${file} has version ${v}, but the tag is ${version}.`);
}

// Same format as src/lib/changelog.ts parses.
const sections = read("CHANGELOG.md").split(/^## /m).slice(1);
const section = sections.find((s) => {
  const head = s.split("\n", 1)[0].trim();
  return head === version || head.startsWith(`${version} `);
});
if (!section) fail(`CHANGELOG.md has no "## ${version}" section.`);
if (!/^### English\s*$/m.test(section) || !/^### Deutsch\s*$/m.test(section)) {
  fail(`CHANGELOG.md section ${version} needs "### English" and "### Deutsch".`);
}

const heading = section.split("\n", 1)[0].trim();
const name = /[–—-]\s*(.+)$/.exec(heading.slice(version.length))?.[1]?.trim();
const body = `## ${section.trim()}\n`;
const delimiter = `NOTES_${Date.now()}`;

process.stdout.write(`name=ZAP ${version}${name ? ` – ${name}` : ""}\n`);
process.stdout.write(`body<<${delimiter}\n${body}${delimiter}\n`);
