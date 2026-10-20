import { describe, expect, it } from '@jest/globals';

import { parseFrontmatter, parseFrontmatterStrict } from './frontmatter.js';

describe('parseFrontmatter empty documents (issue #982)', () => {
  const body = 'body text\n\n## Heading\n# body comment\n';

  it.each([
    ['empty', ''],
    ['whitespace-only', '   \n\t'],
    ['comment-only', '# just a comment'],
    ['bare comment marker', '#'],
    ['multiple comments', '# first\n\n  # second\n\t# third'],
  ])('strips %s frontmatter without changing the body', (_label, yamlRaw) => {
    const content = yamlRaw === ''
      ? `---\n---\n${body}`
      : `---\n${yamlRaw}\n---\n${body}`;

    expect(parseFrontmatter(content)).toEqual({
      tags: [],
      body,
      frontmatter: {},
    });
  });

  it('strips comment-only frontmatter with CRLF line endings', () => {
    const crlfBody = 'body text\r\n\r\n# body comment\r\n';

    expect(parseFrontmatter(`---\r\n# comment\r\n\r\n---\r\n${crlfBody}`)).toEqual({
      tags: [],
      body: crlfBody,
      frontmatter: {},
    });
  });

  it('strips comment-only frontmatter after a UTF-8 BOM', () => {
    expect(parseFrontmatter(`\uFEFF---\n# comment\n---\n${body}`).body).toBe(body);
  });

  it('still parses metadata when comments precede real YAML content', () => {
    const content = `---\n# comment\ntitle: "# not a comment"\ntags: [a, b]\n---\n${body}`;

    expect(parseFrontmatter(content)).toEqual({
      tags: ['a', 'b'],
      body,
      frontmatter: { title: '# not a comment', tags: ['a', 'b'] },
    });
  });

  it('preserves comment-looking lines inside a YAML block scalar', () => {
    const content = `---\nsummary: |\n  # scalar content\n---\n${body}`;
    const result = parseFrontmatter(content);

    expect(result.frontmatter.summary).toBe('# scalar content\n');
    expect(result.body).toBe(body);
  });

  it('still preserves the raw note when YAML is malformed', () => {
    const content = `---\n# comment\ntags: [unterminated\n---\n${body}`;

    expect(parseFrontmatter(content)).toEqual({
      tags: [],
      body: content,
      frontmatter: {},
    });
  });
});

describe('parseFrontmatterStrict compatibility', () => {
  it('continues accepting an empty frontmatter block', () => {
    expect(parseFrontmatterStrict('---\n---\nbody\n')).toEqual({
      frontmatter: {},
      body: 'body\n',
      hasFence: true,
    });
  });

  it('continues rejecting comment-only frontmatter on mutation paths', () => {
    expect(() => parseFrontmatterStrict('---\n# comment\n---\nbody\n'))
      .toThrow('malformed frontmatter');
  });
});
