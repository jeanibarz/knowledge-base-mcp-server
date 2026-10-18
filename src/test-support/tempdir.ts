import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * mkdtemp + realpath. On macOS `os.tmpdir()` returns `/var/folders/...` while
 * `/var` is a symlink to `/private/var`; production code canonicalizes paths
 * via realpath (e.g. `resolveKbPath`, model-index layout, config provenance),
 * so assertions comparing tmpdir-derived expectations against resolved output
 * fail only on macOS. Canonicalizing the temp root up front makes tests
 * platform-consistent — on Linux this is a no-op.
 */
export async function makeTempDir(prefix = 'kb-test-'): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}
