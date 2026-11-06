import path from 'node:path';
import { withFileLock } from '../../src/file-lock.mjs';
import { savePreferences } from '../../src/preferences.mjs';

const [mode, root, prefix] = process.argv.slice(2);
try {
  if (mode === 'hold') {
    await withFileLock(path.join(root, '.git/workgraph-state.lock'), async () => {
      process.send({ state: 'locked' });
      await new Promise(resolve => process.once('message', resolve));
    });
  } else {
    process.send({ state: 'ready' });
    await new Promise(resolve => process.once('message', resolve));
    for (let i = 0; i < 15; i++) {
      const key = `root:${(Number(prefix) * 100 + i).toString(16).padStart(40, '0')}`;
      await savePreferences(root, { review: { key, active: true, files: [`worker-${prefix}-${i}.txt`] } });
    }
  }
  process.send({ state: 'done' });
  process.disconnect();
} catch (error) {
  process.send({ state: 'error', error: error.stack });
  process.exitCode = 1;
  process.disconnect();
}
