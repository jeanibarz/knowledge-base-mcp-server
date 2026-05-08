/**
 * KB-name grammar: `^[a-z0-9][a-z0-9._-]*$`, length 1-64.
 *
 * The leading-char rule rejects dotfiles (`.hidden`), relative traversal
 * (`..`), CLI-flag ambiguity (`-foo`), and the empty string. The tail rule
 * forbids `/`, `\\`, uppercase, and any other separator the filesystem
 * could split on. Null bytes are rejected as a side-effect of the regex
 * character class.
 */
export const KB_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidKbName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length < 1 || name.length > 64) return false;
  return KB_NAME_REGEX.test(name);
}

export function assertValidKbName(name: string): void {
  if (!isValidKbName(name)) {
    throw new Error(`invalid KB name: ${JSON.stringify(name)}`);
  }
}
