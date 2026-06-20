import * as fsp from 'fs/promises';

import {
  isKnownEmbeddingProvider,
  type KnownEmbeddingProvider,
} from './config/provider.js';
import {
  modelDir,
  parseModelId,
  readStoredIndexType,
  readStoredModelName,
  resolveActiveModel,
} from './active-model.js';
import { backendForIndexType } from './config/indexing.js';
import { createEmbeddingsClient } from './embedding-provider.js';
import { resolveActiveIndexFilePath } from './faiss-store-layout.js';

export type ReadinessStatus = 'ok' | 'error';
export type ReadinessCheckName = 'active_model' | 'index' | 'backend';

export interface ReadinessCheck {
  name: ReadinessCheckName;
  status: ReadinessStatus;
}

export interface ReadinessPayload {
  status: ReadinessStatus;
  checks: ReadinessCheck[];
  failing_checks: ReadinessCheckName[];
}

interface ActiveModelProbe {
  modelId: string | null;
  provider: KnownEmbeddingProvider | null;
  modelName: string | null;
  check: ReadinessCheck;
}

export async function buildTransportReadinessPayload(): Promise<ReadinessPayload> {
  const activeModel = await probeActiveModel();
  const index = await probeActiveIndex(activeModel.modelId);
  const backend = await probeEmbeddingBackend(
    activeModel.provider,
    activeModel.modelName,
  );
  const checks = [activeModel.check, index, backend];
  const failingChecks = checks
    .filter((check) => check.status === 'error')
    .map((check) => check.name);
  return {
    status: failingChecks.length === 0 ? 'ok' : 'error',
    checks,
    failing_checks: failingChecks,
  };
}

async function probeActiveModel(): Promise<ActiveModelProbe> {
  try {
    const modelId = await resolveActiveModel();
    const parsed = parseModelId(modelId);
    if (!isKnownEmbeddingProvider(parsed.provider)) {
      throw new Error(`unknown embedding provider in active model: ${parsed.provider}`);
    }
    const modelName = await readStoredModelName(modelId);
    return {
      modelId,
      provider: parsed.provider,
      modelName: modelName ?? parsed.slugBody,
      check: { name: 'active_model', status: 'ok' },
    };
  } catch {
    return {
      modelId: null,
      provider: null,
      modelName: null,
      check: { name: 'active_model', status: 'error' },
    };
  }
}

async function probeActiveIndex(
  modelId: string | null,
): Promise<ReadinessCheck> {
  if (modelId === null) {
    return { name: 'index', status: 'error' };
  }
  try {
    const indexType = await readStoredIndexType(modelId);
    const indexPath = await resolveActiveIndexFilePath(
      modelDir(modelId),
      backendForIndexType(indexType),
    );
    if (indexPath === null) {
      return { name: 'index', status: 'error' };
    }
    const stat = await fsp.stat(indexPath);
    return { name: 'index', status: stat.isFile() ? 'ok' : 'error' };
  } catch {
    return { name: 'index', status: 'error' };
  }
}

async function probeEmbeddingBackend(
  provider: string | null,
  modelName: string | null,
): Promise<ReadinessCheck> {
  if (provider === null || modelName === null || !isKnownEmbeddingProvider(provider)) {
    return { name: 'backend', status: 'error' };
  }
  try {
    const embeddings = await createEmbeddingsClient({ provider, modelName });
    const vector = await embeddings.embedQuery('kb ready backend smoke test');
    return {
      name: 'backend',
      status: isFiniteVector(vector) ? 'ok' : 'error',
    };
  } catch {
    return { name: 'backend', status: 'error' };
  }
}

function isFiniteVector(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}
