// metrics-types.ts — issue #210 / #1006. Leaf module for metrics-domain
// types that need to be shared with lower-layer modules (canonical-log.ts)
// without those modules importing the larger metrics.ts (which would create
// an upward/circular dependency). metrics.ts re-exports from here so its own
// internal usages keep compiling unchanged.

/** Resource kind guarded by the write-lock latency histograms. */
export type WriteLockResourceKind = 'active_index' | 'model_index' | 'other';
