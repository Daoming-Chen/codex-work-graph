import { lstat, open, link, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// All cooperating writers use this lease. We deliberately never steal a lock:
// PID reuse, paused processes and competing stale-lock reclaimers make automatic
// file deletion unsafe. A crashed owner requires the documented offline recovery.
export async function withFileLock(filename, task, { timeoutMs = 5000, retryMs = 25 } = {}) {
  const token = randomUUID();
  const temporary = path.join(path.dirname(filename), `${path.basename(filename)}.${token}.tmp`);
  const owner = JSON.stringify({ version: 1, token, pid: process.pid, createdAt: new Date().toISOString() }) + '\n';
  let handle, acquired = false, identity;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(owner, 'utf8');
    await handle.sync();
    identity = await handle.stat();
    await handle.close(); handle = undefined;
    const deadline = performance.now() + timeoutMs;
    while (!acquired) {
      try {
        // The metadata is complete before the lock becomes visible. Hard-linking
        // in this directory is atomic and never overwrites an existing path.
        await link(temporary, filename);
        acquired = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw new Error('无法创建偏好保存锁；需要支持同目录硬链接的本地文件系统。', { cause: error });
        const info = await lstat(filename).catch(check => { if (check.code === 'ENOENT') return null; throw check; });
        if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('偏好保存锁必须是普通文件，不能使用符号链接。');
        if (performance.now() >= deadline) throw new Error(`偏好保存锁等待超时：${filename}。另一个 WorkGraph 可能正在保存；若进程异常退出，请先停止该仓库的所有 WorkGraph 进程，确认没有保存正在执行后再移除此锁文件。`);
        await delay(retryMs);
      }
    }
    await unlink(temporary);
    return await task();
  } finally {
    await handle?.close().catch(() => {});
    try {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } finally {
      if (acquired) {
        const current = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        // Do not unlink a substituted file or a successor's lease.
        if (current?.isFile() && !current.isSymbolicLink() && current.size === Buffer.byteLength(owner) && current.dev === identity?.dev && current.ino === identity?.ino && await readFile(filename, 'utf8') === owner) await unlink(filename);
      }
    }
  }
}
