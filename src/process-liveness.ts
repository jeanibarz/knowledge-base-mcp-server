/**
 * Returns whether a process id currently refers to a live process.
 *
 * `process.kill(pid, 0)` probes liveness without delivering a signal. An
 * EPERM result still means that the process exists, even when this process
 * cannot signal it.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}
