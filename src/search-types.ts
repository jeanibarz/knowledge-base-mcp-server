// search-types.ts — issue #1006. Leaf module for search-domain types that
// need to be shared with lower-layer modules (canonical-log.ts, metrics.ts)
// without those modules importing the larger search-core.ts (which would
// create an upward/circular dependency). search-core.ts re-exports from
// here so its own internal usages keep compiling unchanged.

/** Reason a dense-search call degraded to a lexical/fallback path. */
export type DenseDegradationReason = 'provider_unavailable' | 'provider_timeout';
