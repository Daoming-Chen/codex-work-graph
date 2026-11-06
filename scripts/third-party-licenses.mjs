import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

// Keep the original notices, including notices from transitive runtime packages.
// This deliberately includes all installed production dependencies, not only
// whichever modules esbuild retained in a particular bundle.
export async function collectThirdPartyLicenses(root) {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const sections = [], seen = new Set();
  for (const [relative, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (!relative || entry.dev) continue;
    if (!relative.startsWith('node_modules/') || relative.split('/').includes('..')) throw new Error('Invalid dependency path in lockfile.');
    const directory = path.join(root, relative);
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (pkg.version !== entry.version) throw new Error(`Dependency version mismatch: ${relative}; run npm ci.`);
    const identity = `${pkg.name}@${pkg.version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const names = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:$|[.\-_])/i.test(name)).sort();
    if (!names.length) throw new Error(`Missing third-party license text: ${identity}`);
    const texts = [];
    for (const name of names) {
      const filename = path.join(directory, name), info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`License must be a regular file: ${identity}/${name}`);
      texts.push(`--- ${name} ---\n${(await readFile(filename, 'utf8')).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd()}\n`);
    }
    sections.push(`\n=== ${identity} (${typeof pkg.license === 'string' ? pkg.license : 'see original text'}) ===\n${texts.join('\n')}`);
  }
  return 'Third-party licenses for WorkGraph distributions\n\nOriginal license and notice texts from installed production dependencies.\nSome listed dependencies may be omitted from a specific bundle.\nMicrosoft Codicons artwork attribution is also in THIRD-PARTY-NOTICES.md.\n' + sections.join('');
}
