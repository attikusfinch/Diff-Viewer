import { fingerprint, linesFor } from './diff';
import type { FileContent, Snapshot, Review } from './types';

const beforeServer = `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getRepository } from '../git/repository';
import { getChanges } from '../git/changes';
import { getFileDiff } from '../git/diff';

const server = new Server(
  { name: 'orbit', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// A small bridge between your agent and your workspace.
// All paths are relative to the active repository.

const fileSchema = z.object({
  path: z.string().min(1),
  base: z.string().default('HEAD'),
});

export async function listChanges() {
  const repository = await getRepository();
  const changes = await getChanges(repository);

  return {
    content: [{ type: 'text', text: JSON.stringify(changes) }],
  };
}

export async function readDiff(input: unknown) {
  const { path, base } = fileSchema.parse(input);
  const repository = await getRepository();
  const diff = await getFileDiff(repository, path, base);

  return {
    content: [{ type: 'text', text: diff }],
  };
}

const tools = {
  list_changes: listChanges,
  read_diff: readDiff,
};

export async function handleTool(name: string, args: unknown) {
  const handler = tools[name as keyof typeof tools];

  if (!handler) {
    throw new Error('Unknown tool: ' + name);
  }

  return handler(args);
}

export async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
`;

const afterServer = beforeServer
  .replace("import { getFileDiff } from '../git/diff';", "import { getFileDiff } from '../git/diff';\nimport { openReview } from '../review/workspace';\nimport { getReviewComments } from '../review/comments';")
  .replace("base: z.string().default('HEAD'),", "base: z.string().default('main'),\n  line: z.number().int().positive().optional(),")
  .replace('const tools = {', `// Bring the human directly to the change that needs attention.
export async function showDiff(input: unknown) {
  const { path, base, line } = fileSchema.parse(input);
  const repository = await getRepository();

  await openReview({ repository, path, base, line });

  return {
    content: [{ type: 'text', text: 'Review opened in Patchwork.' }],
  };
}

export async function readFeedback() {
  const comments = await getReviewComments();

  return {
    content: [{ type: 'text', text: JSON.stringify(comments) }],
  };
}

const tools = {`)
  .replace('  read_diff: readDiff,', '  read_diff: readDiff,\n  show_diff: showDiff,\n  get_review: readFeedback,');

export const demoFiles: Record<string, FileContent> = {
  'src/mcp/server.ts': { path:'src/mcp/server.ts', before:beforeServer, after:afterServer, binary:false, language:'ts' },
  'src/mcp/tools.ts': { path:'src/mcp/tools.ts', before:`export const tools = ['list_changes', 'read_diff'];\n`, after:`export const tools = [\n  'list_changes',\n  'read_diff',\n  'show_diff',\n  'get_review',\n] as const;\n\nexport type ToolName = (typeof tools)[number];\n`, binary:false, language:'ts' },
  'src/review/comments.ts': { path:'src/review/comments.ts', before:'', after:`import type { ReviewComment } from '../types/review';\n\nconst comments = new Map<string, ReviewComment[]>();\n\nexport async function getReviewComments(): Promise<ReviewComment[]> {\n  return [...comments.values()].flat();\n}\n\nexport async function addComment(comment: ReviewComment) {\n  const existing = comments.get(comment.path) ?? [];\n  comments.set(comment.path, [...existing, comment]);\n}\n`, binary:false, language:'ts' },
  'src/review/workspace.ts': { path:'src/review/workspace.ts', before:`export function openReview(path: string) {\n  window.dispatchEvent(new CustomEvent('review', { detail: path }));\n}\n`, after:`interface ReviewContext {\n  repository: string;\n  path: string;\n  base: string;\n  line?: number;\n}\n\nexport async function openReview(context: ReviewContext) {\n  window.dispatchEvent(new CustomEvent('review:open', {\n    detail: context,\n  }));\n}\n`, binary:false, language:'ts' },
  'src/types/review.ts': { path:'src/types/review.ts', before:'', after:`export interface ReviewComment {\n  id: string;\n  path: string;\n  line: number;\n  side: 'before' | 'after';\n  body: string;\n  author: string;\n  createdAt: number;\n}\n\nexport interface ReviewState {\n  reviewed: Record<string, string>;\n  comments: ReviewComment[];\n}\n`, binary:false, language:'ts' },
  'tests/mcp.test.ts': { path:'tests/mcp.test.ts', before:`import { expect, it } from 'vitest';\nimport { listChanges } from '../src/mcp/server';\n\nit('lists repository changes', async () => {\n  const result = await listChanges();\n  expect(result.content).toHaveLength(1);\n});\n`, after:`import { expect, it } from 'vitest';\nimport { listChanges, showDiff } from '../src/mcp/server';\n\nit('lists repository changes', async () => {\n  const result = await listChanges();\n  expect(result.content).toHaveLength(1);\n});\n\nit('opens a review at the requested line', async () => {\n  const result = await showDiff({ path: 'src/mcp/server.ts', line: 24 });\n  expect(result.content[0].text).toBe('Review opened in Patchwork.');\n});\n`, binary:false, language:'ts' },
  'package.json': { path:'package.json', before:'{\n  "name": "orbit",\n  "version": "0.1.0",\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest"\n  }\n}\n', after:'{\n  "name": "orbit",\n  "version": "0.2.0",\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest",\n    "mcp": "tsx src/mcp/server.ts"\n  }\n}\n', binary:false, language:'json' },
  'README.md': { path:'README.md', before:'# Orbit\n\nYour local development workspace.\n\n## Getting started\n\nRun `npm install` and `npm run dev`.\n', after:'# Orbit\n\nYour local development workspace, connected to your agent.\n\n## Getting started\n\nRun `npm install` and `npm run dev`.\n\n## Agent reviews\n\nConnect the MCP server to your coding agent. Use `show_diff` to open\na change in Patchwork, then `get_review` to read human feedback.\n\nEvery review stays local to your machine.\n', binary:false, language:'md' },
};

export function demoSnapshot(base = 'working'): Snapshot {
  return { root:'demo://orbit', name:'orbit', branch:'feat/agent-review', branches:['main','develop','feat/agent-review'], base,
    baseCommit:'9a71c4b', stagedCount:2,
    files: Object.values(demoFiles).map((f,i) => {
      const lines = linesFor(f.before, f.after);
      return {path:f.path, originalPath:null, status:f.before ? 'M' : 'A',
        additions:lines.filter(l=>l.kind==='add').length, deletions:lines.filter(l=>l.kind==='delete').length,
        binary:false, staged:i===1 || i===4,signature:fingerprint(f.before,f.after)};
    }) };
}
export const emptyReview: Review = {reviewed:{},comments:[],plan:{}};
export const demoReview: Review = {
  ...emptyReview,
  plan: {
    'src/mcp/server.ts': {priority:'validate',reason:'Validate input parsing, repository access and the new show_diff tool.',author:'Demo agent'},
    'src/review/workspace.ts': {priority:'validate',reason:'Check that navigation opens the requested file and line, including when switching repositories.',author:'Demo agent'},
    'src/review/comments.ts': {priority:'validate',reason:'Check comment persistence and repository boundaries before accepting the review flow.',author:'Demo agent'},
    'src/types/review.ts': {priority:'low',reason:'Type definitions only; no runtime behavior changes.',author:'Demo agent'},
    'README.md': {priority:'low',reason:'Documentation for the MCP review flow.',author:'Demo agent'},
  },
};
