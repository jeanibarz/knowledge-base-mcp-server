---
fixture_owner: retrieval-eval
status: stable
topic: hybrid
---

# Hybrid Retrieval Tokens

Hybrid retrieval should recover exact identifiers that natural language
embeddings may blur. This fixture includes `ollama__nomic-embed-text-latest`,
`pickleparser`, and `RFC 006` as literal terms that should remain findable.

The same document also describes the natural-language intent: compare lexical
matches with dense semantic matches and merge the rankings without losing
high-confidence paraphrase results.

