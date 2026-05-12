import {
  aggregateCliSearchVariant,
  buildCliSearchVariants,
  parseCliSearchProfile,
  parseCliSearchTimingFromStdout,
  type CliSearchRepetition,
  type CliSearchVariantSpec,
} from './cli-search.js';

describe('parseCliSearchTimingFromStdout', () => {
  it('extracts the timing block from a kb search --format=json --timing payload', () => {
    const payload = {
      results: [],
      index_mtime: '2026-05-12T00:00:00.000Z',
      stale: false,
      modified_files: 0,
      new_files: 0,
      global_stale: false,
      global_modified_files: 0,
      global_new_files: 0,
      timing: {
        requested_mode: 'dense',
        effective_mode: 'dense',
        lexical_kb_list_ms: 2,
        lexical_search_ms: 11,
        bootstrap_ms: 3,
        model_resolution_ms: 1,
        manager_load_ms: 7,
        index_load_ms: 42,
        dense_search_ms: 18,
        embed_query_ms: 12,
        faiss_search_ms: 5,
        query_search_ms: 17,
        fusion_ms: 4,
        post_filter_ms: 1,
        staleness_ms: 9,
        total_ms: 82,
      },
    };
    const stdout = `${JSON.stringify(payload, null, 2)}\n`;
    const timing = parseCliSearchTimingFromStdout(stdout);

    expect(timing).not.toBeNull();
    expect(timing).toEqual({
      lexical_kb_list_ms: 2,
      lexical_search_ms: 11,
      bootstrap_ms: 3,
      model_resolution_ms: 1,
      manager_load_ms: 7,
      index_load_ms: 42,
      dense_search_ms: 18,
      embed_query_ms: 12,
      faiss_search_ms: 5,
      query_search_ms: 17,
      fusion_ms: 4,
      post_filter_ms: 1,
      staleness_ms: 9,
      total_ms: 82,
    });
  });

  it('returns null when the JSON payload has no timing field', () => {
    const stdout = `${JSON.stringify({ results: [] }, null, 2)}\n`;
    expect(parseCliSearchTimingFromStdout(stdout)).toBeNull();
  });

  it('parses the markdown timing footer when the CLI runs with --format=md', () => {
    // Real shape of formatTimingFooter('Timing', timing) for a dense run.
    const stdout = [
      '# Result',
      '',
      'body…',
      '',
      '> _Index up-to-date as of 2026-05-12T00:00:00.000Z._',
      '> _Timing (dense): bootstrap_ms=3ms, index_load_ms=42ms, embed_query_ms=12ms, faiss_search_ms=5ms, post_filter_ms=1ms, staleness_ms=9ms, total_ms=82ms._',
      '',
    ].join('\n');

    const timing = parseCliSearchTimingFromStdout(stdout);
    expect(timing).toEqual({
      bootstrap_ms: 3,
      index_load_ms: 42,
      embed_query_ms: 12,
      faiss_search_ms: 5,
      post_filter_ms: 1,
      staleness_ms: 9,
      total_ms: 82,
    });
  });

  it('returns null on completely unrelated output (e.g. an error line)', () => {
    expect(parseCliSearchTimingFromStdout('kb search: missing <query>\n')).toBeNull();
  });

  it('ignores non-numeric or out-of-schema fields inside the timing block', () => {
    const payload = {
      timing: {
        bootstrap_ms: 3,
        total_ms: 'fast',                // wrong type → dropped
        unrelated_field: 100,             // not in schema → dropped
        post_filter_ms: NaN,              // non-finite → dropped
      },
    };
    const timing = parseCliSearchTimingFromStdout(JSON.stringify(payload));
    expect(timing).toEqual({ bootstrap_ms: 3 });
  });
});

describe('aggregateCliSearchVariant', () => {
  function makeRep(wallMs: number, timing: Record<string, number> | null, rss: number | null = null): CliSearchRepetition {
    return { wall_ms: wallMs, rss_peak_bytes: rss, timing: timing as never };
  }

  function variant(overrides: Partial<CliSearchVariantSpec> = {}): CliSearchVariantSpec {
    return {
      name: 'dense-json-global-k10-prose',
      format: 'json',
      mode: 'dense',
      effectiveMode: 'dense',
      scope: 'global',
      queryShape: 'prose',
      k: 10,
      groupBySource: false,
      args: ['--mode=dense', '--format=json', '--k=10', '--timing'],
      ...overrides,
    };
  }

  it('computes wall p50/p95/p99 and derives process_start_ms = wall_ms - total_ms', () => {
    const reps: CliSearchRepetition[] = [
      makeRep(500, { bootstrap_ms: 10, total_ms: 200 }, 100_000),
      makeRep(520, { bootstrap_ms: 12, total_ms: 210 }, 110_000),
      makeRep(540, { bootstrap_ms: 14, total_ms: 220 }, 105_000),
    ];
    const result = aggregateCliSearchVariant(variant(), reps);

    expect(result.variant).toBe('dense-json-global-k10-prose');
    expect(result.format).toBe('json');
    expect(result.mode).toBe('dense');
    expect(result.effective_mode).toBe('dense');
    expect(result.scope).toBe('global');
    expect(result.query_shape).toBe('prose');
    expect(result.k).toBe(10);
    expect(result.group_by_source).toBe(false);
    expect(result.repetitions).toBe(3);
    expect(result.wall_p50_ms).toBe(520);
    expect(result.wall_p95_ms).toBe(540);
    expect(result.wall_p99_ms).toBe(540);
    expect(result.bootstrap_p50_ms).toBe(12);
    expect(result.cli_total_p50_ms).toBe(210);
    // process_start_p50 is derived per-rep then percentile'd: (300, 310, 320) → p50 = 310.
    expect(result.process_start_p50_ms).toBe(310);
    expect(result.phase_percentiles.process_start_ms).toEqual({ samples: 3, p50_ms: 310, p95_ms: 320, p99_ms: 320 });
    expect(result.phase_percentiles.bootstrap_ms).toEqual({ samples: 3, p50_ms: 12, p95_ms: 14, p99_ms: 14 });
    expect(result.phase_percentiles.total_ms).toEqual({ samples: 3, p50_ms: 210, p95_ms: 220, p99_ms: 220 });
    expect(result.rss_peak_bytes).toBe(110_000);
  });

  it('returns null phase percentiles when no rep emitted that field', () => {
    const reps: CliSearchRepetition[] = [
      makeRep(500, { bootstrap_ms: 10 }),
      makeRep(520, { bootstrap_ms: 12 }),
    ];
    const result = aggregateCliSearchVariant(variant({ name: 'dense-md-global-k10-prose', format: 'md' }), reps);
    expect(result.bootstrap_p50_ms).toBe(10);
    // No rep emitted total_ms, so process_start_ms cannot be derived either.
    expect(result.cli_total_p50_ms).toBeNull();
    expect(result.process_start_p50_ms).toBeNull();
    expect(result.faiss_search_p50_ms).toBeNull();
    expect(result.phase_percentiles.total_ms).toBeUndefined();
  });

  it('returns null rss_peak_bytes when all repetitions lack RSS data (e.g. non-Linux)', () => {
    const reps: CliSearchRepetition[] = [
      makeRep(500, { bootstrap_ms: 10, total_ms: 200 }),
      makeRep(520, { bootstrap_ms: 12, total_ms: 210 }),
    ];
    const result = aggregateCliSearchVariant(variant(), reps);
    expect(result.rss_peak_bytes).toBeNull();
  });

  it('reports the MAX rss across repetitions, not the median', () => {
    // Peak resident memory is a worst-case measure; reporting median would
    // hide the fact that one rep allocated 2× the baseline.
    const reps: CliSearchRepetition[] = [
      makeRep(500, { total_ms: 200 }, 100_000),
      makeRep(520, { total_ms: 210 }, 200_000),
      makeRep(540, { total_ms: 220 }, 100_000),
    ];
    const result = aggregateCliSearchVariant(variant(), reps);
    expect(result.rss_peak_bytes).toBe(200_000);
  });

  it('skips repetitions where a phase field is missing without dropping the rep entirely', () => {
    const reps: CliSearchRepetition[] = [
      makeRep(500, { bootstrap_ms: 10, total_ms: 200 }),
      makeRep(520, { bootstrap_ms: 12 }), // missing total_ms
      makeRep(540, { bootstrap_ms: 14, total_ms: 220 }),
    ];
    const result = aggregateCliSearchVariant(variant(), reps);
    // All three reps still contribute to wall and bootstrap percentiles…
    expect(result.repetitions).toBe(3);
    expect(result.bootstrap_p50_ms).toBe(12);
    // …but cli_total_p50_ms only sees two samples: (200, 220) → p50 = 200.
    expect(result.cli_total_p50_ms).toBe(200);
    // process_start derivation only fires for reps with total_ms: (300, 320) → p50 = 300.
    expect(result.process_start_p50_ms).toBe(300);
  });

  it('throws when called with no repetitions (rather than emitting NaN percentiles)', () => {
    expect(() => aggregateCliSearchVariant(variant(), [])).toThrow(/no repetitions/);
  });

  it('clamps a derived negative process_start_ms to zero', () => {
    // If the CLI's internal total_ms ever exceeds external wall_ms (e.g.
    // due to monotonic-clock skew between Date.now() and process.hrtime),
    // process_start cannot be negative — clamp at 0.
    const reps: CliSearchRepetition[] = [
      makeRep(100, { total_ms: 150 }),
    ];
    const result = aggregateCliSearchVariant(variant(), reps);
    expect(result.process_start_p50_ms).toBe(0);
  });
});

describe('buildCliSearchVariants', () => {
  it('keeps the default profile compact while covering modes, scope, formats, grouping, query shapes, and k values', () => {
    const variants = buildCliSearchVariants('default', 'default');
    const names = variants.map((v) => v.name);

    expect(variants).toHaveLength(7);
    expect(new Set(variants.map((v) => v.mode))).toEqual(new Set(['dense', 'lexical', 'hybrid', 'auto']));
    expect(new Set(variants.map((v) => v.scope))).toEqual(new Set(['global', 'scoped']));
    expect(new Set(variants.map((v) => v.format))).toEqual(new Set(['json', 'md']));
    expect(variants.some((v) => v.groupBySource)).toBe(true);
    expect(new Set(variants.map((v) => v.queryShape))).toEqual(new Set(['prose', 'code']));
    expect(new Set(variants.map((v) => v.k))).toEqual(new Set([5, 10, 25]));
    expect(names).toContain('auto-hybrid-json-global-k10-code');
  });

  it('builds a broader matrix profile for local runs', () => {
    const variants = buildCliSearchVariants('matrix', 'default');
    expect(variants.length).toBeGreaterThan(7);
    expect(variants).toContainEqual(expect.objectContaining({
      name: 'auto-dense-md-scoped-k25-prose',
      args: expect.arrayContaining(['--mode=auto', '--format=md', '--k=25', '--kb=default']),
      effectiveMode: 'dense',
    }));
    expect(variants).toContainEqual(expect.objectContaining({
      name: 'dense-json-global-k5-prose-grouped',
      args: expect.arrayContaining(['--group-by-source']),
      groupBySource: true,
    }));
  });

  it('defaults unknown profile values to the CI-safe default profile', () => {
    expect(parseCliSearchProfile(undefined)).toBe('default');
    expect(parseCliSearchProfile('unexpected')).toBe('default');
    expect(parseCliSearchProfile('matrix')).toBe('matrix');
  });
});
