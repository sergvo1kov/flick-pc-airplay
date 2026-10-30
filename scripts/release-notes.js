'use strict';
// Builds GitHub Release notes for one version from CHANGELOG.md.
//   node scripts/release-notes.js 0.2.3 [owner/repo] > notes.md
// Prints the version's section plus a direct download link. Falls back to a
// generic line when the version has no section, so a release is never empty.

const fs = require('fs');
const path = require('path');

function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const head = new RegExp(`^##\\s*\\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

function releaseNotes(text, version, repo = 'sergvo1kov/flick-pc-airplay') {
  const exe = `FlickAirPlay-Setup-${version}.exe`;
  const url = `https://github.com/${repo}/releases/download/v${version}/${exe}`;
  const section = changelogSection(text, version);
  return [
    `**⬇️ Завантажити:** [${exe}](${url})`,
    '',
    section || 'Виправлення та покращення.',
    '',
    '---',
    'Уже встановлено 0.2.0 або новішу? Оновлення прийде само: **Налаштування → Оновлення → Перевірити**.',
    '',
  ].join('\n');
}

if (require.main === module) {
  const [version, repo] = process.argv.slice(2);
  if (!version) { console.error('usage: release-notes.js <version> [owner/repo]'); process.exit(2); }
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  process.stdout.write(releaseNotes(text, version, repo || undefined));
}

module.exports = { changelogSection, releaseNotes };
