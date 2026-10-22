// Pure help-text → manifest parsing for `kb help --format=json`, extracted
// from cli.ts so the parsing rules are unit-testable in-process (cli.ts itself
// is only exercised via spawned build/cli.js and so reports 0% coverage).

export interface HelpManifestOption {
  flags: string[];
  value: string | null;
  description: string;
}

export interface HelpManifestCommand {
  name: string;
  summary: string;
  usage: string[];
  options: HelpManifestOption[];
  stability: 'stable';
}

export interface HelpManifestDefinition {
  name: string;
  description: string;
}

export const NON_OPTION_HELP_SECTIONS = new Set([
  'Usage:',
  'Examples:',
  'Notes:',
  'Environment:',
  'Exit codes:',
]);

export function extractUsageLines(help: string): string[] {
  const lines = help.split('\n');
  const usageIndex = lines.findIndex((line) => line.trim() === 'Usage:');
  if (usageIndex === -1) return [];
  const usage: string[] = [];
  for (let i = usageIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      if (usage.length === 0) continue;
      const nextContent = lines.slice(i + 1).find((nextLine) => nextLine.trim() !== '');
      if (nextContent !== undefined && nextContent.startsWith('  ')) continue;
      break;
    }
    if (!line.startsWith('  ')) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }
    usage.push(trimmed);
  }
  return usage;
}

export function extractOptions(help: string): HelpManifestOption[] {
  const options: HelpManifestOption[] = [];
  let current: HelpManifestOption | null = null;
  let inOptionSection = false;
  for (const line of help.split('\n')) {
    if (!line.startsWith(' ') && line.trim().endsWith(':')) {
      inOptionSection = isOptionMetadataSection(line.trim());
      current = null;
      continue;
    }
    if (!inOptionSection) {
      continue;
    }
    const optionLine = parseOptionLine(line);
    if (optionLine !== null) {
      current = optionLine;
      options.push(optionLine);
      continue;
    }
    if (current !== null && isContinuationLine(line)) {
      current.description = appendDescription(current.description, line.trim());
    } else if (line.trim() === '') {
      current = null;
    }
  }
  addUsageOptions(options, extractUsageLines(help));
  return options;
}

function isOptionMetadataSection(heading: string): boolean {
  return !NON_OPTION_HELP_SECTIONS.has(heading);
}

export function parseOptionLine(line: string): HelpManifestOption | null {
  if (!line.startsWith('  ')) return null;
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('-')) return null;
  const gap = trimmed.search(/\s{2,}/);
  let flagSpec = trimmed;
  let description = '';
  if (gap >= 0) {
    const left = trimmed.slice(0, gap);
    const isFlagSpec = left
      .split(',')
      .every((part) => {
        const token = part.trim();
        return token.length > 0 && !/\s/.test(token);
      });
    if (isFlagSpec) {
      flagSpec = left;
      description = trimmed.slice(gap).trim();
    }
  }
  const parsedFlags = parseFlagSpec(flagSpec);
  if (parsedFlags.flags.length === 0) return null;
  return {
    flags: parsedFlags.flags,
    value: parsedFlags.value,
    description,
  };
}

export function parseFlagSpec(flagSpec: string): { flags: string[]; value: string | null } {
  const flags: string[] = [];
  let value: string | null = null;
  for (const rawPart of flagSpec.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;
    const eqIndex = part.indexOf('=');
    const flag = eqIndex === -1 ? part : part.slice(0, eqIndex);
    if (!isHelpFlagToken(flag)) continue;
    flags.push(flag);
    if (eqIndex !== -1 && value === null) value = part.slice(eqIndex + 1);
  }
  return { flags, value };
}

function addUsageOptions(options: HelpManifestOption[], usageLines: string[]): void {
  const seen = new Set(options.flatMap((option) => option.flags));
  for (const usageLine of usageLines) {
    for (const flagSpec of usageFlagSpecs(usageLine)) {
      const parsed = parseFlagSpec(flagSpec);
      const newFlags = parsed.flags.filter((flag) => !seen.has(flag));
      if (newFlags.length === 0) continue;
      for (const flag of newFlags) seen.add(flag);
      options.push({
        flags: newFlags,
        value: parsed.value,
        description: '',
      });
    }
  }
}

function usageFlagSpecs(usageLine: string): string[] {
  const specs: string[] = [];
  const matches = usageLine.match(/--[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s\]]+)?/g) ?? [];
  for (const match of matches) {
    if (match.includes('|--')) {
      specs.push(...match.split('|').filter((part) => part.startsWith('--')));
    } else {
      specs.push(match);
    }
  }
  return specs;
}

function isHelpFlagToken(value: string): boolean {
  return value === '--' || /^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);
}

export function extractDefinitionList(help: string, heading: string): HelpManifestDefinition[] {
  const lines = help.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) return [];
  const definitions: HelpManifestDefinition[] = [];
  let current: HelpManifestDefinition[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (line.trim() === '') {
      if (definitions.length > 0) break;
      continue;
    }
    if (!line.startsWith('  ')) break;
    if (isDefinitionContinuationLine(line) && current.length > 0) {
      for (const definition of current) {
        definition.description = appendDescription(definition.description, line.trim());
      }
      continue;
    }
    const rest = line.slice(2);
    const gap = rest.search(/\s{2,}/);
    if (gap > 0) {
      current = pushDefinitions(definitions, rest.slice(0, gap), rest.slice(gap).trim());
      continue;
    }
    current = pushDefinitions(definitions, line.trim(), '');
  }
  return definitions;
}

function pushDefinitions(
  definitions: HelpManifestDefinition[],
  namesText: string,
  description: string,
): HelpManifestDefinition[] {
  const current = namesText.split(',').map((name) => ({
    name: name.trim(),
    description,
  })).filter((definition) => definition.name !== '');
  definitions.push(...current);
  return current;
}

function isContinuationLine(line: string): boolean {
  return line.startsWith('                        ') && line.trim() !== '';
}

function isDefinitionContinuationLine(line: string): boolean {
  return /^ {4,}\S/.test(line);
}

function appendDescription(description: string, continuation: string): string {
  return description === '' ? continuation : `${description} ${continuation}`;
}
