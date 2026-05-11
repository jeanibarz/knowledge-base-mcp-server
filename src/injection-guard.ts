export type InjectionGuardMode = 'off' | 'tag' | 'wrap' | 'both';

export type InjectionSignalKind =
  | 'system_role_marker'
  | 'instruction_override'
  | 'unicode_bidi'
  | 'zero_width'
  | 'unicode_tag';

export interface InjectionSignal {
  kind: InjectionSignalKind;
  match?: string;
  codepoint?: string;
}

export interface InjectionGuardOptions {
  mode: InjectionGuardMode;
  bypassKnowledgeBases: string[];
  wrapOpen: string;
  wrapClose: string;
}

export interface GuardedChunk {
  content: string;
  metadata: Record<string, unknown>;
}

const DEFAULT_WRAP_OPEN = '<untrusted-doc src="{source}">';
const DEFAULT_WRAP_CLOSE = '</untrusted-doc>';

const SYSTEM_ROLE_MARKERS = [
  /<\|im_start\|>/i,
  /<\|begin_of_text\|>/i,
  /<\/?(?:system|assistant)>/i,
  /\[\/?INST\]/i,
  /###\s*(?:Instruction|System)\b/i,
];

const INSTRUCTION_OVERRIDES = [
  /\bignore\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|directions|rules)\b/i,
  /\bforget\s+what\s+you\s+(?:were|are)\s+told\b/i,
  /\bdisregard\s+the\s+system\s+prompt\b/i,
  /\byou\s+are\s+now\s+(?:a|an)\s+[^.!?\n\r]{1,80}/i,
];

export function resolveInjectionGuardOptions(
  env: NodeJS.ProcessEnv = process.env,
): InjectionGuardOptions {
  return {
    mode: parseMode(env.KB_INJECTION_GUARD),
    bypassKnowledgeBases: parseBypassList(env.KB_INJECTION_GUARD_BYPASS_KBS),
    wrapOpen: env.KB_INJECTION_GUARD_WRAP_OPEN ?? DEFAULT_WRAP_OPEN,
    wrapClose: env.KB_INJECTION_GUARD_WRAP_CLOSE ?? DEFAULT_WRAP_CLOSE,
  };
}

export function detectInjectionSignals(content: string): InjectionSignal[] {
  const signals: InjectionSignal[] = [];
  const seen = new Set<string>();

  for (const pattern of SYSTEM_ROLE_MARKERS) {
    const match = content.match(pattern)?.[0];
    if (match !== undefined) addSignal(signals, seen, { kind: 'system_role_marker', match });
  }

  for (const pattern of INSTRUCTION_OVERRIDES) {
    const match = content.match(pattern)?.[0];
    if (match !== undefined) addSignal(signals, seen, { kind: 'instruction_override', match });
  }

  for (const char of content) {
    const codepoint = char.codePointAt(0);
    if (codepoint === undefined) continue;
    const formatted = formatCodepoint(codepoint);
    if (isUnicodeBidiControl(codepoint)) {
      addSignal(signals, seen, { kind: 'unicode_bidi', codepoint: formatted });
    } else if (isZeroWidthControl(codepoint)) {
      addSignal(signals, seen, { kind: 'zero_width', codepoint: formatted });
    } else if (isUnicodeTagControl(codepoint)) {
      addSignal(signals, seen, { kind: 'unicode_tag', codepoint: formatted });
    }
  }

  return signals;
}

export function wrapUntrustedContent(
  content: string,
  metadata: Record<string, unknown> = {},
  options: Pick<InjectionGuardOptions, 'wrapOpen' | 'wrapClose'> = {
    wrapOpen: DEFAULT_WRAP_OPEN,
    wrapClose: DEFAULT_WRAP_CLOSE,
  },
): string {
  const source = escapeAttributeValue(getChunkSource(metadata));
  const open = options.wrapOpen.replaceAll('{source}', source);
  return `${open}\n${content}\n${options.wrapClose}`;
}

export function applyInjectionGuard(
  content: string,
  metadata: Record<string, unknown>,
  options: InjectionGuardOptions = resolveInjectionGuardOptions(),
): GuardedChunk {
  if (options.mode === 'off' || isInjectionGuardBypassed(metadata, options)) {
    return { content, metadata };
  }

  const shouldTag = options.mode === 'tag' || options.mode === 'both';
  const shouldWrap = options.mode === 'wrap' || options.mode === 'both';
  const guardedMetadata = shouldTag
    ? { ...metadata, injection_signals: detectInjectionSignals(content) }
    : metadata;
  const guardedContent = shouldWrap
    ? wrapUntrustedContent(content, metadata, options)
    : content;

  return { content: guardedContent, metadata: guardedMetadata };
}

export function isInjectionGuardBypassed(
  metadata: Record<string, unknown>,
  options: Pick<InjectionGuardOptions, 'bypassKnowledgeBases'>,
): boolean {
  if (options.bypassKnowledgeBases.length === 0) return false;
  const kb = metadata.knowledgeBase;
  return typeof kb === 'string' && options.bypassKnowledgeBases.includes(kb);
}

function parseMode(value: string | undefined): InjectionGuardMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'off' ||
    normalized === 'tag' ||
    normalized === 'wrap' ||
    normalized === 'both'
  ) {
    return normalized;
  }
  return 'tag';
}

function parseBypassList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function getChunkSource(metadata: Record<string, unknown>): string {
  const relativePath = metadata.relativePath;
  if (typeof relativePath === 'string' && relativePath.trim() !== '') return relativePath;
  const source = metadata.source;
  if (typeof source === 'string' && source.trim() !== '') return source;
  const knowledgeBase = metadata.knowledgeBase;
  if (typeof knowledgeBase === 'string' && knowledgeBase.trim() !== '') return knowledgeBase;
  return 'unknown';
}

function escapeAttributeValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function addSignal(
  signals: InjectionSignal[],
  seen: Set<string>,
  signal: InjectionSignal,
): void {
  const key = `${signal.kind}:${signal.match ?? signal.codepoint ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  signals.push(signal);
}

function formatCodepoint(codepoint: number): string {
  return `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function isUnicodeBidiControl(codepoint: number): boolean {
  return (codepoint >= 0x202A && codepoint <= 0x202E) ||
    (codepoint >= 0x2066 && codepoint <= 0x2069);
}

function isZeroWidthControl(codepoint: number): boolean {
  return (codepoint >= 0x200B && codepoint <= 0x200D) || codepoint === 0xFEFF;
}

function isUnicodeTagControl(codepoint: number): boolean {
  return codepoint >= 0xE0020 && codepoint <= 0xE007F;
}
