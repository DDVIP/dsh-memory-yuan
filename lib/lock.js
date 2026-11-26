/**
 * 跨进程短时文件锁。
 *
 * 背景：同一个 vault 有两个写入方（家里渊 / 工作渊），两边各持一份索引快照，
 * 同一时刻改同一个文件会互相覆盖。mkdir() 在 Windows 与 POSIX 上都是原子的，
 * 用它当锁：拿到目录就进临界区，退出时删掉。
 *
 * 纪律：
 *   - 只包「写盘 + 改索引」这段，别把模型调用、读记忆包进来；
 *   - 超时给短一点（默认 2 秒），拿不到就报 LOCK_TIMEOUT，别无限等；
 *   - 锁目录超过 30 秒没动，视为上一个进程崩了留下的僵死锁，清掉重试一次。
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_TIMEOUT = 'LOCK_TIMEOUT';

/** 本进程已持锁的 lock 路径：嵌套调用直接执行，避免同进程自己把自己锁死。 */
const heldInProcess = new Set();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPathOf(vaultPath) {
  return path.join(vaultPath, '.dsh-memory', 'lock');
}

/**
 * 在锁里跑 fn。返回 fn 的返回值。
 * 拿不到锁时抛 Error（code = 'LOCK_TIMEOUT'）。
 */
export function withLock(vaultPath, fn, { timeoutMs = 2000, pollMs = 20, staleMs = 30000 } = {}) {
  if (!vaultPath) throw new Error('withLock 缺少 vaultPath');
  const lockPath = lockPathOf(vaultPath);
  // 同一进程里已经拿着这把锁（例如 tools 包了整段写、store 内部又包一层）：
  // mkdir 会 EEXIST 然后自己等自己到超时，所以这里直接放行。
  if (heldInProcess.has(lockPath)) return fn();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // 锁目录都建不出来（vault 不可写、.dsh-memory 被文件占住）：降级为不加锁，
    // 让真正写盘的那一步去报它自己的错，不在这里把整次写入判死。
    return fn();
  }

  const start = Date.now();
  let clearedStale = false;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // 锁机制本身不可用（权限 / 只读盘）：同样降级，不拦写盘。
        return fn();
      }
      if (!clearedStale) {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            clearedStale = true;
            continue;
          }
        } catch {
          // 锁在检查的一瞬间被释放了，直接重试
          continue;
        }
      }
      if (Date.now() - start >= timeoutMs) {
        const lockError = new Error(`另一个写入方正在写（锁 ${lockPath}），等了 ${timeoutMs}ms 还没释放`);
        lockError.code = LOCK_TIMEOUT;
        throw lockError;
      }
      sleepSync(pollMs);
    }
  }

  heldInProcess.add(lockPath);
  try {
    return fn();
  } finally {
    heldInProcess.delete(lockPath);
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // 释放失败不该盖住 fn 的结果
    }
  }
}

/** 把 withLock 的异常转成 { ok:false, message }，省得每个调用点都写 try/catch。 */
export function tryLock(vaultPath, fn, options) {
  try {
    return withLock(vaultPath, fn, options);
  } catch (error) {
    if (error?.code === LOCK_TIMEOUT) return { ok: false, locked: true, message: error.message };
    return { ok: false, message: `写入失败：${error?.message ?? String(error)}` };
  }
}

export { lockPathOf };
