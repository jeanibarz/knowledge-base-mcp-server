// otel-trace.ts — opt-in OpenTelemetry (OTLP) trace export for the
// retrieve/ask pipeline (issue #647).
//
// Tracing is OFF by default and adds no measurable cost: when
// `KB_OTEL_TRACES` is not enabled, {@link withSpan} resolves to a no-op that
// simply invokes the wrapped function. When enabled, the OpenTelemetry SDK and
// OTLP exporter are loaded *lazily* on first use — mirroring the lazy provider
// imports in `embedding-provider.ts` — so the (optional) `@opentelemetry/*`
// dependency graph never enters the process for the common, tracing-disabled
// case. Standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME` env vars
// are honoured by the OTLP exporter / resource respectively.
//
// Redaction discipline (mirrors the canonical log, ADR 0007): span attributes
// carry only the low-cardinality, non-sensitive facts already present in the
// canonical log line (mode, kb scope, k, counts). Query text and chunk content
// MUST NEVER be attached to a span.
import { logger } from './logger.js';

/** Env flag that opts the process into OTLP trace export. */
export const OTEL_TRACES_ENV = 'KB_OTEL_TRACES';
const OTEL_TRACES_TRUTHY = new Set(['on', 'true', '1', 'yes']);

const DEFAULT_SERVICE_NAME = 'knowledge-base-mcp-server';
const INSTRUMENTATION_SCOPE = 'knowledge-base-mcp-server';

// OpenTelemetry `SpanStatusCode` values (UNSET=0, OK=1, ERROR=2). Inlined so
// the disabled / test path never imports `@opentelemetry/api`.
const SPAN_STATUS_OK = 1;
const SPAN_STATUS_ERROR = 2;

/** Span attribute values we permit — low-cardinality scalars only. */
export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue | null | undefined>;

/**
 * Late-attribute setter handed to the wrapped function so a caller can attach
 * counts that are only known after the work runs (e.g. result_count). Null /
 * undefined values are dropped. No-op when tracing is disabled.
 */
export interface SpanHandle {
  setAttribute(key: string, value: SpanAttributeValue | null | undefined): void;
}

// Minimal structural views of the OTel API surface this module touches. The
// real implementations come from dynamically-imported (untyped) modules; we
// cast at the import boundary so the call sites are type-checked rather than
// `any` (the lint config keeps `no-unsafe-call` on).
interface MinimalSpan {
  setAttribute(key: string, value: SpanAttributeValue): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: Error): unknown;
  end(): unknown;
}

interface MinimalTracer {
  startActiveSpan<T>(name: string, fn: (span: MinimalSpan) => T): T;
}

const NOOP_SPAN_HANDLE: SpanHandle = { setAttribute() { /* no-op */ } };

// Resolution state. `cachedTracer === undefined` means "not yet initialized".
// `null` means resolved-but-disabled (or init failed). A test override takes
// precedence over the lazily-initialized tracer.
let cachedTracer: MinimalTracer | null | undefined;
let initPromise: Promise<MinimalTracer | null> | null = null;
let testTracer: MinimalTracer | null | undefined;

/** Whether `KB_OTEL_TRACES` opts the process into trace export. */
export function isOtelTracesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OTEL_TRACES_ENV]?.trim().toLowerCase();
  return raw !== undefined && OTEL_TRACES_TRUTHY.has(raw);
}

async function resolveTracer(): Promise<MinimalTracer | null> {
  if (testTracer !== undefined) return testTracer;
  if (cachedTracer !== undefined) return cachedTracer;
  if (initPromise === null) initPromise = initTracerProvider();
  cachedTracer = await initPromise;
  return cachedTracer;
}

async function lazyImport(specifier: string): Promise<any> {
  // Indirect specifier so the (optional, possibly-uninstalled) module is not
  // resolved at type-check / build time. Returns `any` by design.
  return import(specifier);
}

interface OtlpExporterModule {
  OTLPTraceExporter: new (config?: Record<string, unknown>) => object;
}
// `@opentelemetry/sdk-trace-node` re-exports the span processors from
// `@opentelemetry/sdk-trace-base`, so we only need the one optional package.
interface SdkNodeModule {
  NodeTracerProvider: new (config: Record<string, unknown>) => {
    register(): void;
    getTracer(name: string): MinimalTracer;
  };
  BatchSpanProcessor: new (exporter: object) => object;
}
interface ResourcesModule {
  resourceFromAttributes(attributes: Record<string, unknown>): object;
}
interface SemconvModule {
  ATTR_SERVICE_NAME: string;
}

async function initTracerProvider(): Promise<MinimalTracer | null> {
  if (!isOtelTracesEnabled()) return null;
  try {
    const sdkNode = (await lazyImport('@opentelemetry/sdk-trace-node')) as SdkNodeModule;
    const otlp = (await lazyImport('@opentelemetry/exporter-trace-otlp-http')) as OtlpExporterModule;
    const resources = (await lazyImport('@opentelemetry/resources')) as ResourcesModule;
    const semconv = (await lazyImport('@opentelemetry/semantic-conventions')) as SemconvModule;

    const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
    // OTLPTraceExporter reads OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    // from the environment when no explicit URL is passed.
    const exporter = new otlp.OTLPTraceExporter();
    const provider = new sdkNode.NodeTracerProvider({
      resource: resources.resourceFromAttributes({ [semconv.ATTR_SERVICE_NAME]: serviceName }),
      spanProcessors: [new sdkNode.BatchSpanProcessor(exporter)],
    });
    // Registers the global tracer + async-context manager so child spans nest
    // under the active parent span across `await` boundaries.
    provider.register();
    logger.info(`OpenTelemetry tracing enabled (service.name=${serviceName}, OTLP/HTTP exporter)`);
    return provider.getTracer(INSTRUMENTATION_SCOPE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `${OTEL_TRACES_ENV} is enabled but OpenTelemetry initialization failed; tracing disabled. `
      + `Install the optional @opentelemetry/* packages to enable trace export. (${message})`,
    );
    return null;
  }
}

function applyAttributes(span: MinimalSpan, attributes: SpanAttributes): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) span.setAttribute(key, value);
  }
}

function spanHandle(span: MinimalSpan): SpanHandle {
  return {
    setAttribute(key, value) {
      if (value !== null && value !== undefined) span.setAttribute(key, value);
    },
  };
}

/**
 * Run `fn` inside a span named `name` with `attributes`, returning whatever
 * `fn` returns. The span becomes the active parent for any spans opened inside
 * `fn`, so nested `withSpan` calls form a parent/child tree. The span records
 * exceptions and is marked ERROR if `fn` throws (the error is re-thrown), OK
 * otherwise.
 *
 * Zero-cost when tracing is disabled: `fn` is invoked directly with a no-op
 * {@link SpanHandle} and no span machinery runs.
 *
 * Attribute discipline: pass only non-sensitive, low-cardinality values
 * (mode, kb, k, counts) — never query text or chunk content.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: SpanHandle) => Promise<T>,
): Promise<T> {
  const tracer = await resolveTracer();
  if (tracer === null) {
    return fn(NOOP_SPAN_HANDLE);
  }
  return tracer.startActiveSpan(name, async (span) => {
    applyAttributes(span, attributes);
    try {
      const result = await fn(spanHandle(span));
      span.setStatus({ code: SPAN_STATUS_OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SPAN_STATUS_ERROR, message: error.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Test seam: install a tracer (or `null` to force the disabled/no-op path)
 * without booting the real SDK. Pass `undefined` to clear the override and fall
 * back to lazy env-driven resolution.
 */
export function setOtelTracerForTesting(tracer: MinimalTracer | null | undefined): void {
  testTracer = tracer;
}

/** Test seam: drop any cached tracer so the next call re-resolves from env. */
export function resetOtelForTesting(): void {
  cachedTracer = undefined;
  initPromise = null;
  testTracer = undefined;
}

export type { MinimalSpan as OtelSpanLike, MinimalTracer as OtelTracerLike };
