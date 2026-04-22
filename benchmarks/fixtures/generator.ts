import * as fsp from 'fs/promises';
import * as path from 'path';
import { MarkdownTextSplitter } from 'langchain/text_splitter';

interface KnowledgeBaseFixtureOptions {
  files: number;
  knowledgeBaseName: string;
  rootDir: string;
  seed: number;
  targetChunksPerFile: number;
}

interface GeneratedFile {
  content: string;
  path: string;
}

export interface KnowledgeBaseFixture {
  chunkCount: number;
  files: number;
  knowledgeBaseName: string;
  query: string;
}

export interface RetrievalChunk {
  chunkIndex: number;
  fileName: string;
  kbName: string;
  text: string;
}

export interface RetrievalQualityFixture {
  chunks: RetrievalChunk[];
  queries: Array<{
    expected: string;
    text: string;
  }>;
}

const VOCABULARY = Array.from({ length: 2_000 }, (_, index) => `token-${index.toString().padStart(4, '0')}`);

export async function generateKnowledgeBaseFixture(
  options: KnowledgeBaseFixtureOptions,
): Promise<KnowledgeBaseFixture> {
  const knowledgeBasePath = path.join(options.rootDir, options.knowledgeBaseName);
  await fsp.mkdir(knowledgeBasePath, { recursive: true });

  const splitter = new MarkdownTextSplitter({
    chunkOverlap: 200,
    chunkSize: 1000,
    keepSeparator: false,
  });
  const random = mulberry32(options.seed);
  const files: GeneratedFile[] = [];
  let totalChunks = 0;

  for (let fileIndex = 0; fileIndex < options.files; fileIndex += 1) {
    const content = await createChunkSizedMarkdown(splitter, random, fileIndex, options.targetChunksPerFile);
    const filePath = path.join(knowledgeBasePath, `doc-${String(fileIndex + 1).padStart(3, '0')}.md`);
    await fsp.writeFile(filePath, content, 'utf-8');
    files.push({ content, path: filePath });

    const documents = await splitter.createDocuments([content], [{ source: filePath }]);
    totalChunks += documents.length;
  }

  const query = extractQueryFromMarkdown(files[0]?.content ?? '');

  return {
    chunkCount: totalChunks,
    files: options.files,
    knowledgeBaseName: options.knowledgeBaseName,
    query,
  };
}

export function generateRetrievalQualityFixture(seed: number): RetrievalQualityFixture {
  const random = mulberry32(seed);
  const chunks: RetrievalChunk[] = [];
  const queries: Array<{ expected: string; text: string }> = [];

  for (let kbIndex = 0; kbIndex < 5; kbIndex += 1) {
    const kbName = `kb-${kbIndex + 1}`;
    for (let fileIndex = 0; fileIndex < 20; fileIndex += 1) {
      const fileName = `doc-${String(fileIndex + 1).padStart(2, '0')}.md`;
      for (let chunkIndex = 0; chunkIndex < 5; chunkIndex += 1) {
        const text = buildRetrievalChunk(random, kbName, fileName, chunkIndex);
        chunks.push({ chunkIndex, fileName, kbName, text });
      }
    }
  }

  for (let queryIndex = 0; queryIndex < 50; queryIndex += 1) {
    const selected = chunks[Math.floor(random() * chunks.length)];
    const tokens = tokenize(selected.text);
    const start = Math.max(0, Math.floor(random() * Math.max(1, tokens.length - 20)));
    const sampled = tokens.slice(start, start + 20).join(' ');
    queries.push({
      expected: retrievalChunkId(selected),
      text: sampled,
    });
  }

  return { chunks, queries };
}

export function retrievalChunkId(chunk: RetrievalChunk): string {
  return `${chunk.kbName}/${chunk.fileName}#${chunk.chunkIndex}`;
}

export function mulberry32(seed: number): () => number {
  let current = seed >>> 0;
  return () => {
    current += 0x6d2b79f5;
    let t = current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function pickVocabularyToken(random: () => number): string {
  return VOCABULARY[Math.floor(random() * VOCABULARY.length)];
}

async function createChunkSizedMarkdown(
  splitter: MarkdownTextSplitter,
  random: () => number,
  fileIndex: number,
  targetChunks: number,
): Promise<string> {
  let sectionCount = targetChunks + 1;
  let candidate = buildMarkdownDocument(random, fileIndex, sectionCount);
  let chunks = await splitter.createDocuments([candidate], [{ source: `fixture-${fileIndex}` }]);

  while (chunks.length < targetChunks) {
    sectionCount += 1;
    candidate = buildMarkdownDocument(random, fileIndex, sectionCount);
    chunks = await splitter.createDocuments([candidate], [{ source: `fixture-${fileIndex}` }]);
  }

  return candidate;
}

function buildMarkdownDocument(random: () => number, fileIndex: number, sections: number): string {
  const parts: string[] = [`# Fixture Document ${fileIndex + 1}`];

  for (let sectionIndex = 0; sectionIndex < sections; sectionIndex += 1) {
    parts.push(`## Section ${sectionIndex + 1}`);
    parts.push(buildParagraph(random, 20));
    parts.push(buildBulletList(random, 3));
    parts.push(buildParagraph(random, 20));
  }

  return `${parts.join('\n\n')}\n`;
}

function buildParagraph(random: () => number, words: number): string {
  const tokens = Array.from({ length: words }, () => pickVocabularyToken(random));
  return tokens.join(' ');
}

function buildBulletList(random: () => number, items: number): string {
  const lines = Array.from({ length: items }, () => `- ${buildParagraph(random, 8)}`);
  return lines.join('\n');
}

function extractQueryFromMarkdown(markdown: string): string {
  return tokenize(markdown)
    .slice(12, 32)
    .join(' ');
}

function buildRetrievalChunk(
  random: () => number,
  kbName: string,
  fileName: string,
  chunkIndex: number,
): string {
  const anchorTokens = [`anchor-${kbName}`, `anchor-${fileName}`, `anchor-chunk-${chunkIndex}`];
  const leading = Array.from({ length: 60 }, () => pickVocabularyToken(random));
  const middle = Array.from({ length: 60 }, () => pickVocabularyToken(random));
  const trailing = Array.from({ length: 60 }, () => pickVocabularyToken(random));

  return [
    ...leading,
    ...anchorTokens,
    ...middle,
    ...anchorTokens,
    ...trailing,
  ].join(' ');
}
