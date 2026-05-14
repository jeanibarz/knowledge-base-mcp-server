/**
 * When false (default), `frontmatter.extras` is stripped from every
 * `retrieve_knowledge` response before JSON serialization. Extras hold
 * non-whitelisted frontmatter keys; defaulting to stripped prevents a
 * workflow-author typo (e.g. `api_key: sk-...` in a note's frontmatter)
 * from leaking onto the wire. The raw value remains on the server-side
 * `Document.metadata` object for local logging. RFC 011 section7.1 R1.
 */
export const FRONTMATTER_EXTRAS_WIRE_VISIBLE: boolean =
  process.env.FRONTMATTER_EXTRAS_WIRE_VISIBLE === 'true';

// ---------------------------------------------------------------------------
// Retrieval citation output (#220).
// ---------------------------------------------------------------------------

export type KBEditorUriMode = 'vscode' | 'cursor' | 'file' | 'none';

export function parseKBEditorUri(raw: string | undefined): KBEditorUriMode {
  if (raw === undefined || raw.trim() === '') return 'none';
  const value = raw.trim().toLowerCase();
  if (value === 'vscode' || value === 'cursor' || value === 'file' || value === 'none') {
    return value;
  }
  throw new Error(`invalid KB_EDITOR_URI=${JSON.stringify(raw)} (expected vscode, cursor, file, or none)`);
}

export const KB_EDITOR_URI: KBEditorUriMode = parseKBEditorUri(process.env.KB_EDITOR_URI);
