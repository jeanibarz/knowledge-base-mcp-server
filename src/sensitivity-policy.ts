import * as fsp from 'fs/promises';
import { parseFrontmatterStrict } from './frontmatter.js';

export type KbResourceReadPolicy = 'allow' | 'local_only' | 'deny';
export type KbResourceReadAccess = 'local' | 'remote';

export interface KbSensitivityPolicy {
  no_llm_context?: boolean;
  resource_read?: KbResourceReadPolicy;
  sensitivity?: string;
}

export interface KbResourceReadDecision {
  allowed: boolean;
  reason?: 'resource_read_deny' | 'resource_read_local_only';
}

export interface LlmContextPolicySnapshot {
  readable: boolean;
  valid: boolean;
  policy: KbSensitivityPolicy | undefined;
}

/**
 * Read the current source policy at an LLM boundary. A missing, unreadable,
 * or malformed source is deliberately not equivalent to a policy-free file.
 */
export async function readLlmContextPolicy(source: string): Promise<LlmContextPolicySnapshot> {
  try {
    const content = await fsp.readFile(source, 'utf-8');
    const frontmatter = parseFrontmatterStrict(content).frontmatter;
    const hasPolicy = Object.prototype.hasOwnProperty.call(frontmatter, 'kb_policy');
    const rawPolicy = frontmatter.kb_policy;
    const policy = normalizeKbSensitivityPolicy(rawPolicy);
    const emptyPolicy = rawPolicy !== null
      && typeof rawPolicy === 'object'
      && !Array.isArray(rawPolicy)
      && Object.keys(rawPolicy as Record<string, unknown>).length === 0;
    return {
      readable: true,
      valid: !hasPolicy || policy !== undefined || emptyPolicy,
      policy,
    };
  } catch {
    return { readable: false, valid: false, policy: undefined };
  }
}

export function normalizeKbSensitivityPolicy(
  value: unknown,
): KbSensitivityPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    // An explicit non-mapping policy cannot be inspected safely. Preserve
    // retrieval while preventing any LLM-boundary caller from treating it as
    // a policy-free document.
    return { no_llm_context: true };
  }
  const raw = value as Record<string, unknown>;
  const policy: KbSensitivityPolicy = {};

  const hasNoLlmContext = Object.prototype.hasOwnProperty.call(raw, 'no_llm_context');
  const noLlmContext = parseBoolean(raw.no_llm_context);
  if (noLlmContext !== undefined) {
    policy.no_llm_context = noLlmContext;
  } else if (hasNoLlmContext) {
    // A malformed confidentiality control must fail closed. Keeping the
    // marker true prevents a valid sibling policy field from accidentally
    // turning an unparseable no_llm_context value into LLM-eligible content.
    policy.no_llm_context = true;
  }

  const resourceRead = parseResourceReadPolicy(raw.resource_read);
  if (resourceRead !== undefined) {
    policy.resource_read = resourceRead;
  }

  if (typeof raw.sensitivity === 'string') {
    const sensitivity = raw.sensitivity.trim();
    if (sensitivity.length > 0) {
      policy.sensitivity = sensitivity;
    }
  }

  if (Object.keys(policy).length > 0) return policy;
  return Object.keys(raw).length > 0 ? { no_llm_context: true } : undefined;
}

export function sensitivityPolicyFromMetadata(
  metadata: Record<string, unknown> | undefined,
): KbSensitivityPolicy | undefined {
  const frontmatter = metadata?.frontmatter;
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return undefined;
  }
  const policy = (frontmatter as Record<string, unknown>).kb_policy;
  return normalizeKbSensitivityPolicy(policy);
}

export function excludesLlmContext(metadata: Record<string, unknown> | undefined): boolean {
  return sensitivityPolicyFromMetadata(metadata)?.no_llm_context === true;
}

export function decideResourceRead(
  policy: KbSensitivityPolicy | undefined,
  access: KbResourceReadAccess,
): KbResourceReadDecision {
  if (policy?.resource_read === 'deny') {
    return { allowed: false, reason: 'resource_read_deny' };
  }
  if (policy?.resource_read === 'local_only' && access === 'remote') {
    return { allowed: false, reason: 'resource_read_local_only' };
  }
  return { allowed: true };
}

export function resolveResourceReadAccess(
  env: NodeJS.ProcessEnv = process.env,
): KbResourceReadAccess {
  return env.MCP_TRANSPORT === 'http' || env.MCP_TRANSPORT === 'sse'
    ? 'remote'
    : 'local';
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function parseResourceReadPolicy(value: unknown): KbResourceReadPolicy | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'allow' || normalized === 'local_only' || normalized === 'deny') {
    return normalized;
  }
  return undefined;
}
