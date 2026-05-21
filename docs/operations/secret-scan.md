# Ingest Secret Scan

`KB_INGEST_SECRET_SCAN=on` scans chunks and lifted frontmatter metadata after
loading and splitting, but before contextual prefaces or embeddings are
produced. If a high-confidence credential shape is detected, the whole source
file is quarantined with `error_category: "secret_detected"` and no chunks from
that file are added to FAISS.

The scanner detects common provider keys, GitHub tokens, JWT-shaped strings,
SSH private-key blocks, bearer headers, password/token assignments, and
high-entropy standalone tokens. It records only categories, chunk indexes,
source locations, and file paths; matched secret text is never written to logs
or quarantine metadata.

Inspect hits with:

```bash
kb quarantine list --reason=secret_detected
```

Use `KB_SECRET_SCAN_BYPASS_KBS=<kb-a>,<kb-b>` for shelves that intentionally
store secret examples, such as auth cookbooks. Existing vectors are not
retroactively removed; run a force reindex with the flag enabled to rebuild an
index under the scanner.
