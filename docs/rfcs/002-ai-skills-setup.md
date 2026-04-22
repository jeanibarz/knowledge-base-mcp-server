# RFC 002 — AI assistant skills bundled with the repo for setup & troubleshooting

- **Status:** Draft — awaiting approval
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 003 (skill testing harness — out of scope here), RFC 004 (long-form agent docs / drift — out of scope here), RFC 007 (architecture & performance)

## 1. Summary

Setting up and troubleshooting this server requires project-specific knowledge that the README spreads across ~160 lines and leaves in several drift-prone spots (hard-coded Cline path at `README.md:94`, a stale flow diagram at `src/knowledge-base-server-flow.md`, a Smithery schema at `smithery.yaml:26` that omits the OpenAI provider the code supports). A user pairing with a Claude Code / Codex-style agent today gets generic help because no in-repo runbook exists (no `CLAUDE.md`, no `.claude/`, no `AGENTS.md`). This RFC proposes a checked-in `.claude/skills/<name>/SKILL.md` layout with eight concrete skills, a frontmatter schema modeled on the `~/.claude/skills/` skills already in use, and a maintenance contract that anchors each skill to specific `file.ts:line` locations so drift is detectable. Skill **implementation** and **automated testing** are explicitly out of scope — this RFC ends at "approved design".

## 2. Motivation

### 2.1 Project-specific knowledge an agent cannot infer from generic training

The questions a new user hits in the first 30 minutes are all project-specific:

- Which Ollama model? The default pinned in code is `dengcao/Qwen3-Embedding-0.6B:Q8_0` (`src/config.ts:19`), not a community-default like `nomic-embed-text`. An agent that invents "just use `ollama pull nomic-embed-text`" will cause a **dimension mismatch** against any existing index (see §2.3).
- Which HuggingFace model? `sentence-transformers/all-MiniLM-L6-v2` (`src/config.ts:15`) — a 384-dim model — is the default, but the agent has no way to know the server will throw if `HUGGINGFACE_API_KEY` is unset (`src/FaissIndexManager.ts:95-98`) versus silently fall back.
- Which MCP client config block? The README shows JSON snippets only for Cline (`README.md:94-155`), at an author-specific path. There is **no** example for Claude Desktop, Codex CLI, Cursor, or Continue, even though the server speaks plain stdio MCP (`src/KnowledgeBaseServer.ts:126`) and works with all of them.
- Why did my queries stop returning results? Three distinct causes — empty `KNOWLEDGE_BASES_ROOT_DIR`, stale FAISS index after a provider switch, or threshold too low — have no documented diagnosis path. The README troubleshooting section is 5 lines (`README.md:220-224`).

### 2.2 No agent-aimed docs exist today

Verified with `ls -la` of the repo root: there is no `CLAUDE.md`, no `.claude/` directory, no `.cursorrules`, no `AGENTS.md`. The only agent-targeted artifact is `src/knowledge-base-server-flow.md`, and it is **stale** — it references "GCP Credentials Available?", "Initialize OpenAI Embeddings", and a "Stubbed Similarity Search", none of which match the current code path (the real flow is the branch at `src/FaissIndexManager.ts:74-105`). An agent that reads this file will be actively misled.

### 2.3 Failure modes that need a runbook, not a line in the README

Three concrete failure modes demonstrate why skills outperform prose:

1. **Embedding dimension / model mismatch.** `FaissIndexManager.initialize()` at `src/FaissIndexManager.ts:128-139` auto-deletes `faiss.index` when `model_name.txt` disagrees with the current `EMBEDDING_PROVIDER`/model. The rebuild then happens via the fallback branch at `src/FaissIndexManager.ts:285-335`, which only fires because `anyFileProcessed && faissIndex === null`. This subtle two-step recovery is not documented anywhere. A user who manually switches `EMBEDDING_PROVIDER` mid-session and hits an empty result set has no way to know whether the rebuild happened or silently failed.
2. **stdio-only logging.** `src/logger.ts:16` initializes destinations to `[process.stderr]` on purpose — writing to stdout would corrupt the JSON-RPC stream (fixed in PR #11, merge `167d2f8`). A generic agent that suggests `console.log` for diagnostics would reintroduce the exact bug PR #11 fixed. A skill can lock the correct guidance in: "set `LOG_FILE`, tail it; never `console.log` from inside this server."
3. **Provider / Smithery drift.** `src/FaissIndexManager.ts:81-92` supports OpenAI, but `smithery.yaml:26` still declares `enum: ["huggingface", "ollama"]`. Users deploying via Smithery cannot select OpenAI even though the code runs it. This is a second drift point that a `setup-openai` skill would surface.

### 2.4 Opportunity

Every tool that speaks either Anthropic's skill convention (`.claude/skills/<name>/SKILL.md`) or the cross-vendor `AGENTS.md` convention will auto-pick up a project-root file when the user opens a workspace at this repo. Shipping curated skills here lets a pairing agent answer "how do I set this up?" with the **exact** model name, **exact** env var, and **exact** file path — rather than best-guessing from stale prose.

## 3. Goals

- G1. **Eight concrete, code-anchored skills** delivered as markdown files in the repo, each with a frontmatter-driven trigger and a tested success path.
- G2. **One canonical on-disk layout** (`.claude/skills/<slug>/SKILL.md`), documented in a `.claude/skills/README.md`, so adding a ninth skill is a mechanical operation.
- G3. **Anchor contract** — every skill file names at least one `file.ts:line` it depends on, so that a follow-up lint step (RFC 003) can flag drift automatically when those anchors move.
- G4. **Coexistence with existing docs** — the README stays the entry point for humans; skills are the entry point for agents. Neither is the source of truth in isolation; both reference §11 of this RFC as the canonical env-var table.
- G5. **Zero runtime cost** — skills are markdown under `.claude/`; they do not ship in the `build/` output (`package.json:8`), the npm package, or the Docker image (`Dockerfile:19-20` copies `build/` only), so installing the server from Smithery/NPM does not pull the skill files.

## 4. Non-goals

- **Writing the skill files themselves.** This RFC delivers the design; an approved follow-up Looper task writes each `SKILL.md`.
- **Automated skill testing / lint harness.** Deferred to RFC 003. This RFC specifies the *manual* validation checklist (§6.4) only.
- **Long-form agent docs (`CLAUDE.md` style).** Deferred to RFC 004. Skills are short, narrow, trigger-driven; the repo-root `CLAUDE.md` question (whether, where, what) is a separate conversation.
- **Refactoring the provider code / fixing `smithery.yaml` drift.** Noted in §8 as blockers that the skill content must work around, but the fixes themselves belong in separate PRs.
- **Changing the MCP tool surface.** `list_knowledge_bases` and `retrieve_knowledge` at `src/KnowledgeBaseServer.ts:34-49` stay exactly as-is.
- **Publishing skills as a standalone package / Smithery artifact.** §7 proposes "in-repo only" as the v1 distribution.

## 5. Current state

### 5.1 What exists

| Artifact | Path | Purpose | Status |
| --- | --- | --- | --- |
| README setup flow | `README.md:10-174` | Human setup walkthrough | Covers 3 providers but only 1 client (Cline) |
| README troubleshooting | `README.md:220-224` | Logging + permission notes | 5 lines, no failure-mode diagnosis |
| Flow diagram | `src/knowledge-base-server-flow.md` | Mermaid of request lifecycle | **Stale** — refs GCP/OpenAI-only/stubbed search |
| Smithery schema | `smithery.yaml:5-54` | Smithery deploy config | **Drift** — no `openai` enum member |
| CHANGELOG | `CHANGELOG.md` | Human-readable history | Current; no troubleshooting content |

### 5.2 What does not exist

```
$ ls -la /home/jean/git/knowledge-base-mcp-server
# no CLAUDE.md, no AGENTS.md, no .cursorrules, no .claude/, no .github/instructions/
```

The repo is currently a "prose-only" codebase from an agent's perspective.

### 5.3 Env vars & failure modes — ground truth

| Env var | Default | Defined at | Failure if wrong |
| --- | --- | --- | --- |
| `KNOWLEDGE_BASES_ROOT_DIR` | `$HOME/knowledge_bases` | `src/config.ts:4-5` | `readdir` throws (`src/KnowledgeBaseServer.ts:54`); returned as tool error |
| `FAISS_INDEX_PATH` | `<root>/.faiss` | `src/config.ts:7-8` | Auto-created (`src/FaissIndexManager.ts:110-117`); permission error surfaced at `:114` |
| `EMBEDDING_PROVIDER` | `huggingface` | `src/config.ts:11` | Unrecognized value falls through to HF branch (`src/FaissIndexManager.ts:93`) |
| `HUGGINGFACE_API_KEY` | _(none)_ | — | Thrown from `src/FaissIndexManager.ts:97` when `EMBEDDING_PROVIDER=huggingface` |
| `HUGGINGFACE_MODEL_NAME` | `sentence-transformers/all-MiniLM-L6-v2` | `src/config.ts:14-15` | Silent API 404 from HF; surfaced as unhandled promise |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | `src/config.ts:18` | Connection refused → error at first retrieval |
| `OLLAMA_MODEL` | `dengcao/Qwen3-Embedding-0.6B:Q8_0` | `src/config.ts:19` | Ollama returns "model not found" if unpulled |
| `OPENAI_API_KEY` | _(none)_ | — | Thrown from `src/FaissIndexManager.ts:85` when `EMBEDDING_PROVIDER=openai` |
| `OPENAI_MODEL_NAME` | `text-embedding-ada-002` | `src/config.ts:22` | OpenAI 404 on wrong name |
| `LOG_FILE` | _(none)_ | `src/logger.ts:18` | Best-effort; permission failure logged to stderr at `:46` |
| `LOG_LEVEL` | `info` | `src/logger.ts:14-15` | Invalid value silently coerced to `info` at `:15` |

### 5.4 Client integrations — what the codebase assumes

The server uses `StdioServerTransport` (`src/KnowledgeBaseServer.ts:126`) and logs exclusively to stderr (`src/logger.ts:16`). This makes it compatible with any MCP client that launches child processes over stdio: Claude Desktop, Codex CLI, Cursor, Continue, Cline, Zed. The README currently documents only the Cline config block at `/home/jean/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (`README.md:94`) — author-specific and not applicable to any other client.

## 6. Proposed design

### 6.1 On-disk layout

```
<repo-root>/
└── .claude/
    └── skills/
        ├── README.md                                      # 6.3: authoring guide
        ├── setup-ollama/SKILL.md
        ├── setup-huggingface/SKILL.md
        ├── setup-openai/SKILL.md
        ├── configure-mcp-client/SKILL.md
        ├── configure-mcp-client/snippets/                 # copy-pasteable JSON
        │   ├── claude-desktop.json
        │   ├── codex-cli.toml
        │   ├── cursor.json
        │   ├── continue.json
        │   └── cline.json
        ├── add-knowledge-base/SKILL.md
        ├── troubleshoot-embedding-dimension-mismatch/SKILL.md
        ├── troubleshoot-mcp-unreachable/SKILL.md
        └── troubleshoot-index-empty-or-stale/SKILL.md
```

**Why `.claude/skills/`**: matches the existing `~/.claude/skills/` layout used on Jean's workstation (see `oss-task-checkpointing`, `pr-contribution-excellence`), so the schema is already battle-tested. The `.claude/` directory is project-scoped but dotfile-hidden, keeping it out of the default `ls` output and out of `npm pack` and `docker build` unless explicitly added.

**Packaging impact — verified**: `package.json` has no `files` field, so npm defaults to "everything except ignored"; `Dockerfile:19-20` copies only `build/`; `smithery.yaml` doesn't ship files. **Recommendation**: add `.claude/` to `.npmignore` explicitly so an accidental publish doesn't ship skills as runtime assets. §10 tracks this.

### 6.2 Skill file format

Each `SKILL.md` uses YAML frontmatter plus a fixed-order body. Schema:

```markdown
---
name: <slug>                                # kebab-case; matches directory name
description: <one sentence>                 # shown to the agent during skill selection
keywords: [kw1, kw2, ...]                   # 3–8 entries, lowercase, single words or hyphenated
anchors:                                    # files/symbols this skill claims knowledge of
  - src/config.ts::OLLAMA_MODEL
  - src/FaissIndexManager.ts::FaissIndexManager.constructor
  - README.md:45-55                         # fallback line range allowed for prose files
applies_to:                                 # closed enum; see below
  - claude-code
  - codex-cli
  - cursor
  - continue
last_verified: 2026-04-22                   # ISO-8601 UTC; bump only after re-checking anchors
---

## When to use
<1–3 bullets of triggering situations>

## Prerequisites
<env vars / external installs required>

## Steps
1. ...
2. ...

## Verification
<shell command(s) the user can run to confirm success; must exit 0>

## Failure modes
| Symptom | Cause | Fix |

## See also
<cross-links to sibling skills>
```

**Frontmatter grammar (normative):**

- `name` — regex `^[a-z][a-z0-9-]*$`; must equal the parent directory name.
- `description` — one sentence, ≤ 140 chars.
- `keywords` — 3 to 8 entries; each entry matches `^[a-z][a-z0-9-]*$` (single lowercase word or hyphenated).
- `anchors` — a YAML list. Each list item is either:
  - **Symbol anchor** (preferred): `<repo-relative-path>::<symbol>` where `<symbol>` is an exported name, a class member (`ClassName.method`), a constructor (`ClassName.constructor`), or a constant identifier defined in that file. **A symbol anchor must resolve to exactly one line** — if the verification grep below returns 0 matches, the anchor is broken (rename / delete event); if it returns 2+ matches (overloads, duplicate names in different classes, shadowing), the author **must** fall back to a line-range anchor to disambiguate.
  - **Line range** (fallback, for prose files like `README.md`, for anonymous blocks, or for disambiguating duplicate symbols): `<repo-relative-path>:<start>[-<end>]`. `<start>`/`<end>` are 1-indexed line numbers.
  - Paths are POSIX, repo-relative, no leading `./`. Multiple anchors in the same file become multiple list entries. Mixing symbol and line-range anchors on the same file is allowed.

  **Worked verification commands** (used by §6.4 step 1 and by the future RFC 003 harness):

  | Anchor shape | Example | Verification command (must return exactly 1 line) |
  | --- | --- | --- |
  | Exported const | `src/config.ts::OLLAMA_MODEL` | `grep -nE '^export const OLLAMA_MODEL\b' src/config.ts` |
  | Top-level const (not exported) | `src/FaissIndexManager.ts::MODEL_NAME_FILE` | `grep -nE '^const MODEL_NAME_FILE\b' src/FaissIndexManager.ts` |
  | Top-level function | `src/utils.ts::getFilesRecursively` | `grep -nE '^(export )?(async )?function getFilesRecursively\b' src/utils.ts` |
  | Class method | `src/KnowledgeBaseServer.ts::KnowledgeBaseServer.run` | `awk '/^export class KnowledgeBaseServer\b/,/^\}/' src/KnowledgeBaseServer.ts \| grep -nE '^\s*(async\s+)?run\s*\(' ` |
  | Class constructor | `src/FaissIndexManager.ts::FaissIndexManager.constructor` | `awk '/^export class FaissIndexManager\b/,/^\}/' src/FaissIndexManager.ts \| grep -nE '^\s*constructor\s*\('` |
  | Line range (prose or anonymous) | `README.md:45-55` | `sed -n '45,55p' README.md` (manual inspection; no grep) |

  When the table's command returns 0 or 2+ hits for a symbol anchor, the skill author must either rename the symbol in code to restore uniqueness or switch the anchor to a line range. `.claude/skills/README.md` (C3) ships this table verbatim so every skill author runs the same verification.
- `applies_to` — closed enum: `claude-code | claude-desktop | codex-cli | cursor | continue | cline`. `claude-code` (the CLI) and `claude-desktop` (the desktop app) are distinct targets. Skills that are client-agnostic list all six.
- `last_verified` — ISO-8601 date in UTC (`YYYY-MM-DD`). Bump **only** after a full re-verification of every `anchors` entry (see §6.4 step 1). Editing the skill body without re-checking anchors must leave the date unchanged.

**Why symbol anchors over line numbers.** A line-range anchor (`src/config.ts:18-19`) breaks the instant anyone inserts code above line 18. Symbol anchors (`src/config.ts::OLLAMA_MODEL`) follow the code through edits and only break when the symbol is renamed or deleted — which is the event a drift signal should actually catch. Line ranges remain as the fallback for prose files (the README) and for anonymous blocks where no stable symbol exists.

Fields chosen to match the `~/.claude/skills/oss-task-checkpointing/SKILL.md` frontmatter already in use (`name`, `description`, `keywords`), plus three additions specific to this repo: `anchors` (for drift detection), `applies_to` (scope), `last_verified` (manual staleness signal). The symbol-anchor grammar above is what RFC 003's future test harness will parse — specified in §10.

### 6.3 Skill catalog

Each entry below specifies: **trigger** (when the skill fires), **output** (what the user receives), **primary anchors** (the `file.ts:line` the skill's correctness depends on).

#### S1 — `setup-ollama`

- **Trigger:** user says "install ollama", "use ollama", "switch to local embeddings", or agent detects `EMBEDDING_PROVIDER=ollama` in the user's env.
- **Output:** platform-specific install command (Linux curl, macOS brew, Windows installer), the exact `ollama pull dengcao/Qwen3-Embedding-0.6B:Q8_0` command, a `curl http://localhost:11434/api/tags` verification step, and the 3-line env block the server reads.
- **Primary anchors:** `src/config.ts::OLLAMA_MODEL`, `src/config.ts::OLLAMA_BASE_URL`, `src/FaissIndexManager.ts::FaissIndexManager.constructor`, `README.md:45-55`.

#### S2 — `setup-huggingface`

- **Trigger:** "use huggingface", "free tier embeddings", or `EMBEDDING_PROVIDER=huggingface`.
- **Output:** HF token acquisition URL, the exact model slug (default `HUGGINGFACE_MODEL_NAME`), rate-limit notes (HF free tier throttles silently), and the throw-path the user will see if `HUGGINGFACE_API_KEY` is missing.
- **Primary anchors:** `src/config.ts::HUGGINGFACE_MODEL_NAME`, `src/config.ts::DEFAULT_HUGGINGFACE_MODEL_NAME`, `src/FaissIndexManager.ts::FaissIndexManager.constructor`, `README.md:68-78`.

#### S3 — `setup-openai`

- **Trigger:** "use openai", "set up openai embeddings", `EMBEDDING_PROVIDER=openai`.
- **Output:** API key acquisition URL, `text-embedding-ada-002` vs. `text-embedding-3-small` cost/quality note (with dated list prices), warning that **Smithery deployment cannot currently select OpenAI** (drift — see §8), and the throw-path if `OPENAI_API_KEY` is unset.
- **Primary anchors:** `src/config.ts::OPENAI_MODEL_NAME`, `src/FaissIndexManager.ts::FaissIndexManager.constructor`, `README.md:57-66`, `smithery.yaml:26` _(drift marker; line range used because the enum is an anonymous YAML value)_.

#### S4 — `configure-mcp-client`

- **Trigger:** "add this server to <Claude Desktop|Codex CLI|Cursor|Continue|Cline>", "MCP config".
- **Output:** a per-client snippet from `.claude/skills/configure-mcp-client/snippets/<client>.{json,toml}`, filled in with placeholders. Each snippet is **literally copy-pasteable** after substituting `<PATH_TO_BUILD_INDEX>`, `<KB_ROOT>`, and the provider env vars.
- **Primary anchors:** `src/KnowledgeBaseServer.ts::KnowledgeBaseServer.run` (stdio transport), `src/index.ts:1` (shebang makes the built file directly executable), `README.md:94-155` _(single-client example today)_.
- **Matrix (v1):**

  | Client | Config path | Format | Notes |
  | --- | --- | --- | --- |
  | Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows) | JSON | `mcpServers.<name>` |
  | Codex CLI | `~/.codex/config.toml` | TOML | `[mcp_servers.<name>]` |
  | Cursor | `~/.cursor/mcp.json` | JSON | Project-level variant: `<project>/.cursor/mcp.json` |
  | Continue | `~/.continue/config.json` | JSON | `experimental.modelContextProtocolServers` |
  | Cline | path in `README.md:94` | JSON | Current README snippet; preserve for parity |

  Paths are the published defaults as of 2026-04-22. Skill body must carry a `last_verified` date and a "check the client's current docs if the path differs" footer.

#### S5 — `add-knowledge-base`

- **Trigger:** "add a knowledge base", "where do I put docs", "how do I index new files".
- **Output:** directory scaffold (`$KNOWLEDGE_BASES_ROOT_DIR/<kb-name>/*.md`), the hidden-file rule (dot-prefixed names are skipped — see `getFilesRecursively`), how re-indexing is triggered (lazy, on next `retrieve_knowledge` call), and the SHA-based change detection.
- **Primary anchors:** `src/utils.ts::getFilesRecursively`, `src/utils.ts::calculateSHA256`, `src/FaissIndexManager.ts::FaissIndexManager.updateIndex`, `src/KnowledgeBaseServer.ts::KnowledgeBaseServer.handleListKnowledgeBases`.

#### S6 — `troubleshoot-embedding-dimension-mismatch`

- **Trigger:** "I switched providers", "results are empty after changing model", "dim mismatch", "faiss error after update".
- **Output:** explanation of the `model_name.txt` / `faiss.index` two-file dance, the fact that the rebuild happens via the fallback branch inside `updateIndex` (only fires when `anyFileProcessed && faissIndex === null`), and a **guarded** manual recovery command. The recovery command MUST use the guarded form below (never bare `rm -rf $FAISS_INDEX_PATH`):
  ```bash
  : "${FAISS_INDEX_PATH:?set FAISS_INDEX_PATH before running recovery}"
  : "${KNOWLEDGE_BASES_ROOT_DIR:?set KNOWLEDGE_BASES_ROOT_DIR before running recovery}"
  # Refuse dangerous values before any rm: root, cwd, home, parent-dir shortcuts.
  case "$FAISS_INDEX_PATH" in
    /|//|.|./|..|../|~|"$HOME") echo "refusing to rm $FAISS_INDEX_PATH"; exit 1 ;;
  esac
  case "$KNOWLEDGE_BASES_ROOT_DIR" in
    /|//|.|./|..|../|~|"$HOME") echo "refusing to scan $KNOWLEDGE_BASES_ROOT_DIR"; exit 1 ;;
  esac
  [ -d "$FAISS_INDEX_PATH" ] && rm -rf -- "$FAISS_INDEX_PATH"
  find "$KNOWLEDGE_BASES_ROOT_DIR" -mindepth 2 -maxdepth 2 -type d -name .index -print0 \
    | xargs -0 -I{} rm -rf -- "{}"
  ```
- **Primary anchors:** `src/FaissIndexManager.ts::MODEL_NAME_FILE`, `src/FaissIndexManager.ts::FaissIndexManager.initialize`, `src/FaissIndexManager.ts::FaissIndexManager.updateIndex`.

#### S7 — `troubleshoot-mcp-unreachable`

- **Trigger:** "Claude Desktop doesn't see the server", "tool not appearing", "MCP handshake fail".
- **Output:** diagnostic checklist — (a) `node build/index.js` runs cleanly with `EMBEDDING_PROVIDER` + key set, (b) `LOG_FILE` captures the stderr stream, (c) remind that writing to stdout corrupts JSON-RPC (PR #11, merge `167d2f8`), (d) verify the client config path for the specific client (cross-link S4).
- **Primary anchors:** `src/logger.ts:16` _(stderr-only destination; line anchor because it's an assignment inside a module top-level block, not a symbol)_, `src/KnowledgeBaseServer.ts::KnowledgeBaseServer.run`, `src/index.ts:1-11`.

#### S8 — `troubleshoot-index-empty-or-stale`

- **Trigger:** "retrieve_knowledge returns nothing", "no similar results", "score too high".
- **Output:** three-branch diagnosis — (a) empty KB: run `list_knowledge_bases`, expect non-empty array; (b) permission: check FAISS/Index dir writability (permission errors are surfaced with explicit messages by the `handleFsOperationError` helper); (c) threshold: `retrieve_knowledge` default is 2, raising it broadens recall. Note on overlap with S6: S6 covers the case where the index file was deleted or model metadata is inconsistent; S8 covers the case where the index exists but returns no hits. Cross-link S6 in the "## See also" block.
- **Primary anchors:** `src/KnowledgeBaseServer.ts::KnowledgeBaseServer.handleListKnowledgeBases`, `src/KnowledgeBaseServer.ts::KnowledgeBaseServer.handleRetrieveKnowledge`, `src/FaissIndexManager.ts::FaissIndexManager.similaritySearch`, `src/FaissIndexManager.ts::handleFsOperationError`.

### 6.4 Manual validation checklist (per skill)

Every `SKILL.md` PR must include, in the PR body:

1. **Anchor pass** — `grep -n` each `file.ts:line` from the frontmatter's `anchors` block; confirm the line(s) still contain the code the skill claims they do. Paste the grep output.
2. **Dry run** — open a fresh Claude Code / Codex session in a scratch clone with an empty `$KNOWLEDGE_BASES_ROOT_DIR`, invoke the skill, follow the steps verbatim. Record the terminal transcript.
3. **Verification step pass** — the "## Verification" section's shell command must exit `0` on the user's machine after the steps complete.
4. **Cross-link integrity** — every "See also" link must resolve to an existing sibling `SKILL.md`.

Automation of these four checks is deferred to RFC 003. This RFC commits only to making them a **manual PR gate** when an implementation PR lands.

### 6.5 Cross-linking between skills

Skills reference each other by **relative sibling path**, always ending in `SKILL.md` or a `snippets/<file>` path. Example: `[configure-mcp-client](../configure-mcp-client/SKILL.md)`. Rules:

- **Only relative sibling paths** starting with `../<skill-slug>/` are allowed. Repo-absolute paths (`/.claude/skills/...`) are forbidden because they break when skills are read outside the repo root.
- **No anchor fragments on cross-links** (`#verification`). Section names drift and rot; link to the whole file. This rule applies only to **links between skills** — in-file section headers (`## Verification`) in the skill body are fine, they just can't be targeted from another skill.
- **Links to snippet files** (`../configure-mcp-client/snippets/claude-desktop.json`) are allowed in addition to `SKILL.md`.
- External URLs (Ollama / HuggingFace / OpenAI docs) are allowed inline where relevant and must carry a `last_verified` note in the same paragraph.

The `configure-mcp-client` skill is the hub; every setup skill (S1/S2/S3) links forward to it, and every troubleshoot skill (S6/S7/S8) links back to the relevant setup skill. S6 and S8 cross-link each other explicitly given their adjacent scope (see S8 output above).

### 6.6 Where the README moves

The README stays as today for the human-first path. It gains exactly one new paragraph in the Setup section:

> **Pairing with an AI assistant?** Open this repo in Claude Code, Codex CLI, Cursor, or Continue and the agent will auto-discover skills under `.claude/skills/`. Start by asking it: *"help me set up knowledge-base-mcp-server with <ollama|huggingface|openai>"*.

No other README content changes. The hard-coded Cline path at `README.md:94` is kept for backward compatibility; the new `configure-mcp-client` skill subsumes and generalizes it.

## 7. Distribution

v1 ships skills **in-repo only**. Rationale:

- Zero new tooling required.
- Skills live next to the code they document, so a PR touching `src/config.ts` is visible in the same diff as a PR touching `.claude/skills/setup-ollama/SKILL.md`. Reviewers catch drift.
- Runtime image excludes `.claude/` because `Dockerfile:19-20` copies only `build/` into the final stage. The **builder** stage (`Dockerfile:9` = `COPY . .`) would otherwise pull `.claude/` into the intermediate layer and bloat the build cache; C2 in §12 adds a `.dockerignore` to exclude it. Similarly, C1 adds an explicit `.npmignore` entry so `npm publish` does not ship skill content as runtime assets (`package.json` has no `files` field today, so npm defaults to "everything not ignored").

v2 candidates (explicitly **deferred**, documented here only so they aren't re-litigated):

- Publish skills as a Smithery-installable bundle.
- Mirror skills under `~/.claude/skills/` via a postinstall hook.
- A thin root-level `AGENTS.md` pointer is shipped in v1 (C4 in §12) to reach Codex CLI / non-Anthropic agents. Growing `AGENTS.md` into the primary convention — with `.claude/skills/` as a supplementary Anthropic-specific layer — is an **open question** (see §9.2 / OQ5); if Jean prefers that inversion, the catalog content is the same and only `AGENTS.md` grows.

## 8. Alternatives considered

### 8.1 "Put everything in a longer README"

Expand `README.md:220-224` into a 500-line troubleshooting section. **Rejected** because:
- Agents do not reliably extract the right ~20 lines from a 600-line README during a user's question.
- No anchor / drift contract — stale content rots silently.
- Cross-cutting topics (e.g. dimension mismatch is both "setup" and "troubleshoot") duplicate across sections.

### 8.2 "One big `CLAUDE.md` at repo root"

Write a single agent-facing doc instead of per-skill files. **Rejected** because:
- One file invites unbounded growth; skills stay short and on-topic.
- Per-skill `anchors` frontmatter enables drift lints (RFC 003); a monolith would need ad-hoc section markers.
- `CLAUDE.md` auto-loads into every turn of every conversation in this repo — paying that token cost for "troubleshoot-mcp-unreachable" content when the user is doing something unrelated is wasteful.
- Not mutually exclusive: a thin `CLAUDE.md` that lists skills and points at them is compatible with this RFC and is proposed as an RFC 004 follow-up.

### 8.3 "Generate skills from the README via a linter"

Use a script to extract troubleshooting paragraphs and emit `SKILL.md` files. **Rejected** because:
- The README's prose is not structured enough to parse reliably.
- Generated content that references `file.ts:line` still needs manual verification — the lint would need to be hand-audited every run, which is not cheaper than hand-writing.
- Forecloses the option of *improving* skill content beyond what the README says.

### 8.4 "AGENTS.md at repo root only"

Ship the cross-vendor `AGENTS.md` convention instead of `.claude/skills/`. **Rejected as primary** because:
- `AGENTS.md` is one file by convention — same monolithic downside as §8.2.
- Anthropic's `SKILL.md` frontmatter (`name`, `description`, `keywords`) already exists in the user's workflow (`~/.claude/skills/`), so the authoring muscle memory is there.
- **Not rejected entirely**: a thin `AGENTS.md` that points at `.claude/skills/README.md` is cheap and increases discoverability for non-Anthropic agents. Tracked in §10.

## 9. Risks, unknowns, open questions

### 9.1 Known risks

- **R1 — Anchor drift.** Symbol anchors (`src/config.ts::OLLAMA_MODEL`) survive line shifts but still break on rename / delete. **Mitigation:** the `last_verified` field makes staleness visible on sight; §6.4 step 1 requires a `grep` of every anchor on every skill PR; the RFC 003 harness (tracked in C15) will automate it. Until RFC 003 lands, drift stays the headline risk.
- **R2 — Skill auto-loading behavior varies by client.** Claude Code uses `~/.claude/skills/` and plugin-scoped skills; whether it auto-picks up project-local `.claude/skills/` on `cd` into the repo depends on the client version. **Mitigation:** each skill file includes explicit activation instructions in the "## When to use" section so a user can `/skill <name>` manually even if auto-discovery fails. This RFC does **not** promise auto-activation semantics it cannot verify.
- **R3 — Codex CLI / Cursor / Continue may not read `.claude/`.** The dotfolder is Anthropic-branded; other vendors use `AGENTS.md` or their own conventions. **Mitigation:** C4 in §12 ships a root `AGENTS.md` pointer in v1; OQ5 tracks whether to invert (make `AGENTS.md` primary).
- **R4 — Smithery drift blocks `setup-openai`.** `smithery.yaml:26` lacks OpenAI. A Smithery-installed user cannot follow S3 fully. **Mitigation:** S3 documents the gap explicitly; C15 files a tracking issue for a separate PR that fixes the schema.
- **R5 — Maintenance tax on `src/` PRs.** Every future change to `src/config.ts`, `src/FaissIndexManager.ts`, `src/logger.ts`, or `src/KnowledgeBaseServer.ts` may require bumping one or more skills' `last_verified` dates and, if symbols are renamed, their `anchors` entries. For a solo-maintained repo this is real ongoing friction. **Mitigation:** symbol anchors cut the most common drift case (line shifts) to zero touches; the `anchors` list in §6.3 intentionally names **only the narrowest symbol each skill depends on**, so a single-file edit rarely invalidates more than one or two skills. If the tax proves too high in practice, collapsing the catalog per OQ6 is the escape hatch.

### 9.2 Open questions

- **OQ1** — Should the repo also ship a root `CLAUDE.md` that is a one-paragraph pointer to `.claude/skills/README.md`? The author's inclination is yes, but it pulls CLAUDE.md scoping questions into a design that was trying to stay narrow. **Proposal:** defer to RFC 004.
- **OQ2** — Should `configure-mcp-client` snippets include real example values (concrete `/Users/jean/...` paths) or only placeholders (`<PATH_TO_BUILD_INDEX>`)? Real values are more copy-pasteable; placeholders are more portable. **Proposal:** placeholders only, because real values from one machine mislead users on other machines — the current README's hard-coded path is the cautionary tale.
- **OQ3** — What about Windows? The server runs on Node, which is portable, but none of the README or the flow doc address Windows specifics. Each skill may need Linux/macOS/Windows splits, which doubles or triples the content. **Proposal:** v1 ships Linux + macOS only; Windows notes land in a v2 sweep.
- **OQ4** — Should `setup-openai` warn about cost? A `text-embedding-ada-002` call at 1M tokens costs pennies, but a user auto-indexing a giant KB could be surprised. **Proposal:** include a brief cost block with current list prices, dated via `last_verified`.
- **OQ5** — Primary convention: `.claude/skills/` or `AGENTS.md`? A skeptical review flagged that `.claude/` is Anthropic-specific and reflects the author's personal workflow, while `AGENTS.md` is cross-vendor and increasingly adopted. This RFC picks `.claude/skills/` as primary (for the frontmatter-driven per-skill format that a monolithic `AGENTS.md` would lose) **plus** a thin `AGENTS.md` pointer for discoverability. If Jean prefers the inversion, the catalog content is unchanged and only the file layout flips. **Decision point for Jean.**
- **OQ6** — Catalog size: 8 skills vs. 3–4? A skeptical review flagged that S1/S2/S3 are structurally identical (install → env → verify) and could collapse into one `setup-embeddings` skill with three sections; S6 and S8 overlap on post-provider-switch symptoms. This RFC keeps 8 because per-skill activation triggers are narrower than section headings (an agent picking between "setup-ollama" and "setup-huggingface" by description is cheaper than parsing a big skill for the right section), but the collapsed alternative is cheaper to maintain. **Decision point for Jean.** If collapsed, the rollout plan shrinks from 5 implementation PRs to 2.

## 10. Rollout plan

1. **This RFC approved.** No code changes yet. Approval must include explicit answers to **OQ5** (primary convention) and **OQ6** (catalog size) in §9.2, because both change the rollout shape: OQ5 flips the file layout `.claude/skills/` ↔ `AGENTS.md`, and OQ6-collapsed shrinks this plan from 5 implementation PRs to 2.
2. **Implementation PR 1 — scaffolding** (separate Looper task):
   - Create `.claude/skills/README.md` describing the authoring contract from §6.2–§6.4.
   - Add `.claude/` to `.npmignore` (new file — currently absent).
   - Add `.dockerignore` entry for `.claude/` (new file — currently absent; `Dockerfile:9` does a blanket `COPY . .` which would pull `.claude/` into the builder stage and inflate cache layers).
   - Add a thin root-level `AGENTS.md` pointing at `.claude/skills/README.md` (satisfies R3). **Safe to land first** — it only points at the authoring guide, not at individual skills.
   - No skill content in this PR.
3. **Implementation PR 2 — setup triad** (separate Looper task): `setup-ollama`, `setup-huggingface`, `setup-openai`. Each skill passes the §6.4 manual checklist in the PR body.
4. **Implementation PR 3a — configure-mcp-client (core)**: the skill body plus snippets for **Claude Desktop** and **Cline** (parity with the existing README path). §6.4 dry-run for these two clients.
5. **Implementation PR 3b — configure-mcp-client (extensions)**: snippets for **Codex CLI**, **Cursor**, **Continue**. Lands after 3a so the skill is partially usable in the interim.
6. **Implementation PR 4 — troubleshoot triad**: `troubleshoot-embedding-dimension-mismatch`, `troubleshoot-mcp-unreachable`, `troubleshoot-index-empty-or-stale`.
7. **Implementation PR 5 — add-knowledge-base**.
8. **README update**: append the one paragraph from §6.6. **Gated on PRs 2, 3a, 3b, 4, 5 all being merged** — the README paragraph points users at `.claude/skills/` as a whole, and it would be actively misleading to land it while the catalog is half-populated.
9. **Delete `src/knowledge-base-server-flow.md`** (decided: delete, not mark-deprecated; git history preserves the prior content). Lands in the same PR as step 8 to keep the stale doc removal paired with the new pointer.
10. **Post-rollout**: file a separate issue for `smithery.yaml` to add the `openai` provider (resolves R4), and file a tracking issue for RFC 003 (skill testing harness).

**Backward compatibility:** zero. Skills are additive markdown. No behavior change in the server. No env var renames. No dependency changes.

**Feature flags / deprecation windows:** none required.

**Rollback:** each implementation PR is self-contained markdown. A bad skill can be reverted with `git revert` without touching code. The step-8 README update is the only step with a cross-dependency (see gating above); reverting it is a one-commit change.

## 11. Success metrics

All metrics below are **artifact-measurable** — they can be checked today (M2/M4/M5) or by a short scripted command that this RFC specifies verbatim (M1/M3). No subjective judgement, no author-only measurement.

- **M1 — Verification commands pass.** Every `SKILL.md`'s `## Verification` block is a shell command that exits `0` when run from a fresh clone on Linux and macOS after following the skill's steps. Until RFC 003 lands a GitHub Actions matrix, measured by a terminal transcript in each implementation PR's body (§6.4 artifact 3).
- **M2 — Env-var coverage.** Every env var in §5.3 is named in at least one skill's `Prerequisites` or `Steps` section. Measured by `grep -rl <VAR_NAME> .claude/skills/` for each of the 11 env vars (recursive flag is POSIX; no shell-specific globstar required).
- **M3 — Anchor freshness.** Every skill's `last_verified` date is within 90 days of the **most recent commit on `main`** that touches any file listed under `anchors`. Baseline: for anchor `src/config.ts::OLLAMA_MODEL`, the baseline commit is `git log -1 --format=%cI -- src/config.ts`; if that ISO date is newer than `last_verified` by more than 90 days, the anchor is stale. One-liner (ships in `.claude/skills/README.md` per C3):
  ```bash
  last_verified=$(grep -E '^last_verified:' SKILL.md | awk '{print $2}')
  for f in $(grep -E '^\s*-\s*' SKILL.md | awk '{print $2}' | cut -d: -f1 | sort -u); do
    code_date=$(git log -1 --format=%cI -- "$f")
    # fail the skill if days(code_date - last_verified) > 90
  done
  ```
- **M4 — Client coverage.** Five MCP clients (Claude Desktop, Codex CLI, Cursor, Continue, Cline) have populated snippet files under `.claude/skills/configure-mcp-client/snippets/`. Measured by `ls`.
- **M5 — README drift closed.** After step 9 of §10 lands, `src/knowledge-base-server-flow.md` no longer exists, and `README.md:94` no longer points at an author-specific path. Measured by `git ls-files` and `grep`.

## 12. Implementation checklist

Each item below is sized to fit in a single small PR. Order is the intended merge order.

**Required in the PR body for every skill PR (C5–C12; not C13 which is prose-only):**

1. Anchor pass — `grep -n` output for every `anchors` entry, showing the symbol or line is still there.
2. Dry-run transcript — terminal log of following the skill end-to-end in a fresh clone with an empty `$KNOWLEDGE_BASES_ROOT_DIR`.
3. Verification exit code — the `## Verification` command printed `$?` of `0`.
4. Cross-link check — `ls` output confirming every `See also` link resolves to an existing sibling file.

- [ ] **C1.** Add `.npmignore` with `.claude/` entry.
- [ ] **C2.** Add `.dockerignore` with `.claude/` entry (currently absent; `Dockerfile:9` copies everything into the builder).
- [ ] **C3.** Create `.claude/skills/README.md` with the §6.2 frontmatter spec and the §6.4 validation checklist.
- [ ] **C4.** Create root-level `AGENTS.md` as a thin pointer to `.claude/skills/README.md` (one paragraph).
- [ ] **C5.** Skill `setup-ollama` with Linux + macOS steps, anchors from §6.3 S1, verification: `curl -s http://localhost:11434/api/tags | grep -q dengcao`. + four §6.4 artifacts in PR body.
- [ ] **C6.** Skill `setup-huggingface`, anchors §6.3 S2, verification: `curl -s -H "Authorization: Bearer $HUGGINGFACE_API_KEY" https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2 -d '{"inputs":"hello"}' | jq length`. + four §6.4 artifacts.
- [ ] **C7.** Skill `setup-openai`, anchors §6.3 S3, verification: `curl -s -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models/text-embedding-ada-002 | jq .id`. Must include the Smithery-drift warning from §8/R4. + four §6.4 artifacts.
- [ ] **C8a.** Skill `configure-mcp-client` body + snippets for **Claude Desktop** and **Cline**. + four §6.4 artifacts (dry-run against both clients).
- [ ] **C8b.** Skill `configure-mcp-client` extension: snippets for **Codex CLI**, **Cursor**, **Continue**. + four §6.4 artifacts (dry-run against each).
- [ ] **C9.** Skill `add-knowledge-base`, anchors §6.3 S5, verification: `list_knowledge_bases` returns the new KB name. + four §6.4 artifacts.
- [ ] **C10.** Skill `troubleshoot-embedding-dimension-mismatch`, anchors §6.3 S6. Recovery command must use the guarded form from S6 (never bare `rm -rf $FAISS_INDEX_PATH`). + four §6.4 artifacts.
- [ ] **C11.** Skill `troubleshoot-mcp-unreachable`, anchors §6.3 S7. + four §6.4 artifacts.
- [ ] **C12.** Skill `troubleshoot-index-empty-or-stale`, anchors §6.3 S8. Must cross-link S6. + four §6.4 artifacts.
- [ ] **C13.** README: append the §6.6 paragraph to the Setup section, **and** delete `src/knowledge-base-server-flow.md` in the same PR. Gated on C5–C12 all merged.
- [ ] **C14.** File follow-up issue: `smithery.yaml` add `openai` to `embeddingProvider.enum` (fixes R4).
- [ ] **C15.** File follow-up RFC: skill testing harness (RFC 003) — automate the §6.4 manual checklist and publish M1/M3 CI jobs.

Each of C5–C12 is a self-contained PR: one skill, one set of verified anchors, the four required artifacts in the PR body, and no code changes outside `.claude/`.
