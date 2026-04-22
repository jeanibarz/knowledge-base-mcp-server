import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import { HuggingFaceInferenceEmbeddings } from '@langchain/community/embeddings/hf';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

describe('HuggingFaceInferenceEmbeddings compatibility', () => {
  it('posts to an explicit endpoint override using the v4 client', async () => {
    const requests: Array<{
      url: string | undefined;
      authorization: string | undefined;
      body: unknown;
    }> = [];

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      requests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: await readJsonBody(req),
      });

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([[0.5, 0.25, 0.125]]));
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected server to listen on an ephemeral TCP port');
    }

    const endpointUrl = `http://127.0.0.1:${address.port}/custom/embed`;

    try {
      const embeddings = new HuggingFaceInferenceEmbeddings({
        apiKey: 'test-key',
        model: 'sentence-transformers/all-MiniLM-L6-v2',
        endpointUrl,
      });

      const result = await embeddings.embedQuery('hello endpoint');

      expect(result).toEqual([0.5, 0.25, 0.125]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({
        url: '/custom/embed',
        authorization: 'Bearer test-key',
        body: {
          inputs: ['hello endpoint'],
        },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
