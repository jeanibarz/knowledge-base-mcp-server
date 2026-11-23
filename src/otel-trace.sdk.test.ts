// Real-SDK test for otel-trace.ts: boots the actual optional @opentelemetry/*
// packages against a local OTLP/HTTP listener. The other otel tests inject a
// fake tracer, so without this file an SDK upgrade that breaks initialization
// would only log a warning and silently disable tracing while CI stays green.
//
// The traced code runs in a child `node` process on the built `build/`
// output: the OTLP exporter does its own dynamic `import()`, which jest's CJS
// runtime cannot service (see the transform note in jest.config.js).
import { spawn } from 'child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

interface OtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}
interface OtlpAttribute {
  key: string;
  value: { stringValue?: string };
}
interface OtlpTraceRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ spans: OtlpSpan[] }>;
  }>;
}

const otelModuleUrl = pathToFileURL(path.join(process.cwd(), 'build', 'otel-trace.js')).href;

// Opens a parent span, crosses an await boundary, opens a child span, then
// flushes. The child must still see the parent as the active span.
const CHILD_SCRIPT = `
const otel = await import(${JSON.stringify(otelModuleUrl)});
await otel.withSpan('parent', { mode: 'test' }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await otel.withSpan('child', { k: 1 }, async () => 'ok');
});
await otel.shutdownOtel(5000);
`;

function runChild(endpoint: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
      env: {
        ...process.env,
        KB_OTEL_TRACES: 'on',
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_SERVICE_NAME: 'otel-sdk-test',
        LOG_FILE: '',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('otel-trace with the real OpenTelemetry SDK', () => {
  const requests: Array<{ url: string | undefined; body: string }> = [];
  let server: http.Server;
  let endpoint: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        requests.push({ url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('exports nested spans over OTLP/HTTP with the configured service name', async () => {
    const { code, output } = await runChild(endpoint);
    expect({ code, output }).toEqual({ code: 0, output: expect.any(String) });
    expect(output).toContain('OpenTelemetry tracing enabled');
    expect(output).not.toContain('initialization failed');
    expect(output).not.toContain('forceFlush failed');

    const traceRequests = requests.filter((r) => r.url === '/v1/traces');
    expect(traceRequests.length).toBeGreaterThan(0);
    const payloads = traceRequests.map((r) => JSON.parse(r.body) as OtlpTraceRequest);
    const spans = payloads.flatMap((p) => p.resourceSpans.flatMap(
      (rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
    const parent = spans.find((s) => s.name === 'parent');
    const child = spans.find((s) => s.name === 'child');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.traceId).toBe(parent?.traceId);
    expect(child?.parentSpanId).toBe(parent?.spanId);

    const serviceName = payloads[0].resourceSpans[0].resource.attributes
      .find((a) => a.key === 'service.name')?.value.stringValue;
    expect(serviceName).toBe('otel-sdk-test');
  });
});
