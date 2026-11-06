import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Compare both staged and unstaged changes: the committed standalone runtime
// must match a fresh build. CI runs this immediately after npm run build.
try {
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--',
    'skills/workgraph/scripts', 'skills/workgraph/LICENSE',
    'plugins/workgraph/LICENSE', 'plugins/workgraph/THIRD-PARTY-LICENSES.txt',
    'plugins/workgraph/THIRD-PARTY-NOTICES.md'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
  });
} catch {
  console.error('Generated skill assets or distribution licenses are out of date. Run npm run build and commit the generated files.');
  process.exitCode = 1;
}
