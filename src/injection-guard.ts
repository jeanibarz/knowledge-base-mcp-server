export type InjectionGuardMode = 'off' | 'tag' | 'wrap' | 'both';

export type InjectionSignalKind =
  | 'system_role_marker'
  | 'instruction_override'
  | 'wrapper_delimiter'
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
const WRAPPER_CODEC_CANDIDATES = [
  0x2060, // word joiner
  0x2061, // function application
  0x2062, // invisible times
  0x2063, // invisible separator
  0x2064, // invisible plus
  0x200B, // zero-width space
  0x200C, // zero-width non-joiner
  0x200D, // zero-width joiner
];

interface WrapperDelimiterCodec {
  delimiters: string[];
  escape: string;
  signature: string;
  break: string;
  reserved: Set<string>;
  singleDelimiterCodes: Map<string, string>;
  delimitersBySingleCode: Map<string, string>;
}

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

export function detectInjectionSignals(
  content: string,
  options: Pick<InjectionGuardOptions, 'wrapClose'> = { wrapClose: DEFAULT_WRAP_CLOSE },
): InjectionSignal[] {
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

  if (options.wrapClose !== '' && content.includes(options.wrapClose)) {
    addSignal(signals, seen, { kind: 'wrapper_delimiter', match: options.wrapClose });
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
  const neutralizedContent = neutralizeWrapperDelimiters(content, options);
  return `${open}\n${neutralizedContent}\n${options.wrapClose}`;
}

export function neutralizeWrapperDelimiters(
  content: string,
  options: Pick<InjectionGuardOptions, 'wrapOpen' | 'wrapClose'>,
): string {
  const codec = createWrapperDelimiterCodec(options);
  const needsEncoding = codec.delimiters.some((delimiter) => content.includes(delimiter)) ||
    [...codec.reserved].some((reserved) => content.includes(reserved));
  if (!needsEncoding) return content;

  let neutralized = codec.escape + codec.signature;
  for (let offset = 0; offset < content.length;) {
    const current = codepointAt(content, offset);
    if (codec.reserved.has(current)) {
      neutralized += codec.escape + current;
      offset += current.length;
      continue;
    }

    const delimiter = codec.delimiters.find((candidate) =>
      content.startsWith(candidate, offset)
    );
    if (delimiter === undefined) {
      neutralized += current;
      offset += current.length;
      continue;
    }

    const singleCode = codec.singleDelimiterCodes.get(delimiter);
    if (singleCode !== undefined) {
      neutralized += singleCode;
    } else {
      for (const char of delimiter) {
        neutralized += codec.singleDelimiterCodes.get(char) ?? `${char}${codec.break}`;
      }
    }
    offset += delimiter.length;
  }
  return neutralized;
}

export function restoreWrapperDelimiters(
  content: string,
  options: Pick<InjectionGuardOptions, 'wrapOpen' | 'wrapClose'>,
): string {
  // Call only after content has left the wrapper trust boundary. Any caller
  // rebuilding an envelope must neutralize the restored text again first.
  const codec = createWrapperDelimiterCodec(options);
  const prefix = codec.escape + codec.signature;
  if (!content.startsWith(prefix)) return content;

  let restored = '';
  for (let offset = prefix.length; offset < content.length;) {
    const current = codepointAt(content, offset);
    if (current === codec.escape) {
      const escapedOffset = offset + current.length;
      if (escapedOffset >= content.length) {
        restored += current;
        offset = escapedOffset;
        continue;
      }
      const escaped = codepointAt(content, escapedOffset);
      if (codec.reserved.has(escaped)) {
        restored += escaped;
        offset = escapedOffset + escaped.length;
        continue;
      }
    }

    if (current === codec.break) {
      offset += current.length;
      continue;
    }
    const singleDelimiter = codec.delimitersBySingleCode.get(current);
    restored += singleDelimiter ?? current;
    offset += current.length;
  }
  return restored;
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
    ? { ...metadata, injection_signals: detectInjectionSignals(content, options) }
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

function configuredDelimiters(
  options: Pick<InjectionGuardOptions, 'wrapOpen' | 'wrapClose'>,
): string[] {
  return [...new Set([options.wrapOpen, options.wrapClose])]
    .filter((delimiter) => delimiter !== '')
    .sort((left, right) => right.length - left.length);
}

function createWrapperDelimiterCodec(
  options: Pick<InjectionGuardOptions, 'wrapOpen' | 'wrapClose'>,
): WrapperDelimiterCodec {
  const delimiters = configuredDelimiters(options);
  const singleDelimiters = delimiters.filter((delimiter) => [...delimiter].length === 1);
  const reservedChars = selectWrapperCodecCharacters(delimiters, 3 + singleDelimiters.length);
  const [escape, signature, delimiterBreak, ...singleCodes] = reservedChars;
  if (escape === undefined || signature === undefined || delimiterBreak === undefined) {
    throw new Error('Unable to reserve wrapper delimiter codec characters');
  }
  const singleDelimiterCodes = new Map<string, string>();
  const delimitersBySingleCode = new Map<string, string>();
  for (const [index, delimiter] of singleDelimiters.entries()) {
    const code = singleCodes[index];
    if (code === undefined) {
      throw new Error('Unable to reserve a single-character delimiter code');
    }
    singleDelimiterCodes.set(delimiter, code);
    delimitersBySingleCode.set(code, delimiter);
  }
  return {
    delimiters,
    escape,
    signature,
    break: delimiterBreak,
    reserved: new Set(reservedChars),
    singleDelimiterCodes,
    delimitersBySingleCode,
  };
}

function selectWrapperCodecCharacters(delimiters: string[], count: number): string[] {
  const delimiterCharacters = new Set(delimiters.flatMap((delimiter) => [...delimiter]));
  const selected: string[] = [];
  const consider = (codepoint: number): void => {
    const char = String.fromCodePoint(codepoint);
    if (!delimiterCharacters.has(char)) selected.push(char);
  };

  for (const codepoint of WRAPPER_CODEC_CANDIDATES) {
    if (selected.length >= count) break;
    consider(codepoint);
  }
  for (let codepoint = 0xE000; selected.length < count && codepoint <= 0xF8FF; codepoint += 1) {
    consider(codepoint);
  }
  return selected;
}

function codepointAt(value: string, offset: number): string {
  const codepoint = value.codePointAt(offset);
  if (codepoint === undefined) return '';
  return String.fromCodePoint(codepoint);
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
