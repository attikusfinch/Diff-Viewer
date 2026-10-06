export interface ChangedFile {
  path: string;
  originalPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  staged: boolean;
  signature: string;
}
export interface Snapshot {
  root: string;
  name: string;
  branch: string;
  branches: string[];
  base: string;
  baseCommit: string;
  files: ChangedFile[];
  stagedCount: number;
}
export interface FileContent {
  path: string;
  before: string;
  after: string;
  binary: boolean;
  language: string;
  signature?: string;
  images?: {before: ImageSide | null; after: ImageSide | null};
}
export interface ImageSide { dataUrl: string | null; mime: string | null; bytes: number; error: string | null }
export interface Comment {
  id: string;
  path: string;
  line: number;
  side: 'before' | 'after';
  body: string;
  author: string;
  createdAt: number;
}
export type ReviewPriority = 'validate' | 'normal' | 'low';
export interface ReviewPlanItem {
  priority: ReviewPriority;
  reason: string;
  author: string;
  signature?: string;
}
export interface Review { reviewed: Record<string, string>; comments: Comment[]; plan: Record<string, ReviewPlanItem> }
export interface Connection {
  command: string;
  args: string[];
  clients: { id: string; name: string; version: string; lastSeen: number }[];
  available: boolean;
  error?: string;
}
export interface Preferences {
  theme: 'graphite' | 'midnight' | 'light' | 'terminal';
  fontSize: number;
  wrap: boolean;
  layout: 'split' | 'unified';
  context: number;
  sidebarWidth: number;
  filesLayout: 'tree' | 'list';
  changesExpanded: boolean;
}
export type Mode = 'diff' | 'file';
export interface ShowDiff { root: string; base: string; path?: string; line?: number; mode?: Mode }
