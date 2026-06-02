# Neighbor Context Search Windows

`kb search` can include nearby chunks from the same source file around each
dense semantic match:

```bash
kb search "rollback after failed deploy" --context-before=1 --context-after=2
kb search "incident handoff checklist" --context-window=1
kb search "rollback after failed deploy" --context-window=1 --format=json
```

Use these flags when the matching chunk is likely to be part of a longer note
whose surrounding paragraphs carry the setup, commands, or caveats needed to
act on the result. The ranked hit stays the semantic match; the neighbor
chunks are returned as extra context around that hit.

## Flag Behavior

- `--context-before=<n>` includes up to `n` preceding chunks from the same
  source file.
- `--context-after=<n>` includes up to `n` following chunks from the same
  source file.
- `--context-window=<n>` is shorthand for setting both before and after to the
  same value.
- Counts are chunk counts, not lines or paragraphs.
- Neighbor context is dense-only. `kb search` defaults to dense mode, but
  `--mode=lexical`, `--mode=hybrid`, and `--mode=auto` when it selects hybrid
  reject neighbor expansion.

Neighbor windows do not improve or change ranking. The dense search first
finds the top semantic matches, then the formatter attaches nearby chunks from
the same source file. A neighbor chunk can be useful evidence, but it was not
itself ranked as a top match.

## When It Helps

Runbooks and long operational notes often split a procedure across adjacent
chunks:

```bash
kb search "restart worker after queue timeout" --kb=ops --context-window=1
```

The semantic match might be the exact restart command, while the previous chunk
explains when to use it and the next chunk lists verification checks. A small
window also helps meeting notes where a decision and its rationale land on
different sides of a chunk boundary.

## When It Dilutes Output

Keep the window at zero, or at most one chunk, when:

- source files mix multiple topics;
- you only need compact citations for scanning;
- the matched note is already short;
- you are passing results directly into a small LLM context budget.

Large windows can bury the relevant match under nearby but unrelated prose. If
the output feels noisy, lower the window and make the source note more
splittable with clearer headings.

## Markdown Output

The default markdown output labels the ranked hit as the semantic match when
neighbors are present, then renders neighbor chunks below that hit:

```markdown
**Result 1 (semantic match):**

**Score:** 0.42

Primary matching chunk text...

**Context chunks:**

- **Context (before, distance 1):**

  Previous chunk text...

- **Context (after, distance 1):**

  Following chunk text...
```

The exact source metadata block and freshness footer follow the normal
`kb search` markdown contract. Neighbor chunks are context for the same result,
not additional ranked results.

## JSON Output

With `--format=json`, the primary hit stays in `results[]`. Neighbor chunks are
attached under `context_chunks`:

```json
{
  "results": [
    {
      "score": 0.42,
      "content": "Primary matching chunk text...",
      "match_type": "semantic",
      "semantic_match": true,
      "chunk_id": "ops/runbooks/deploy.md#L42-L78",
      "context_chunks": [
        {
          "match_type": "context",
          "semantic_match": false,
          "direction": "before",
          "distance": 1,
          "content": "Previous chunk text...",
          "chunk_id": "ops/runbooks/deploy.md#L20-L41"
        }
      ]
    }
  ]
}
```

Agents should branch on `semantic_match` or `match_type` rather than assuming
every returned text block was independently ranked. `context_chunks[].distance`
is measured from the semantic match within the same source file.

## Choosing Values

Start with `--context-window=1` for long notes and runbooks. Prefer asymmetric
windows when the document shape is predictable:

```bash
kb search "post-deploy verification" --context-before=0 --context-after=2
kb search "why did we choose sq8 indexes" --context-before=2 --context-after=0
```

Use a wider window only for source files with a single coherent topic. If you
regularly need large windows to make results understandable, split or retitle
the source notes so the dense match carries more local context by itself.
