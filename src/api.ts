import { invoke, isTauri } from '@tauri-apps/api/core';
import { demoFiles, demoSnapshot, demoReview, emptyReview } from './demo';
import type { Review, Snapshot, Comment } from './types';

export const desktop = isTauri();
let snapshot: Snapshot = demoSnapshot();
const reviews = new Map<string, Review>();
reviews.set('working',structuredClone(demoReview));

export async function api<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (desktop) return invoke<T>('api', {method, params});
  const base = String(params.base ?? snapshot.base);
  let review = reviews.get(base) ?? structuredClone(emptyReview);
  let result: unknown;
  switch (method) {
    case 'open_repository': throw new Error('Opening a local Git repository requires the desktop app. This browser workspace is an interactive demo.');
    case 'get_snapshot': {
      snapshot.base = base;
      result = {...snapshot, files: base === 'staged' ? snapshot.files.filter(f=>f.staged) : snapshot.files}; break;
    }
    case 'get_file': result = demoFiles[String(params.path)]; break;
    case 'get_review': result = review; break;
    case 'set_review_plan': {
      const entries=params.files as {path:string;priority:'validate'|'normal'|'low';reason?:string}[];
      review={...review,plan:Object.fromEntries(entries.map(item=>[item.path,{priority:item.priority,reason:item.reason??'',author:'You'}]))};
      reviews.set(base,review);result=review;break;
    }
    case 'set_reviewed': {
      review = structuredClone(review);
      if (params.reviewed) review.reviewed[String(params.path)] = String(params.fingerprint);
      else delete review.reviewed[String(params.path)];
      reviews.set(base, review); result = review; break;
    }
    case 'add_comment': {
      review = structuredClone(review);
      review.comments.push({id:crypto.randomUUID(), path:String(params.path), line:Number(params.line), side:params.side ?? 'after',
        body:String(params.body), author:'You', createdAt:Math.floor(Date.now()/1000)} as Comment);
      reviews.set(base, review); result = review; break;
    }
    case 'delete_comment': {
      review = {...review, comments:review.comments.filter(c=>c.id !== params.id)};
      reviews.set(base, review); result = review; break;
    }
    case 'stage_file': {
      snapshot = {...snapshot, files:snapshot.files.map(f=>f.path===params.path ? {...f,staged:!!params.staged} : f)};
      snapshot.stagedCount = snapshot.files.filter(f=>f.staged).length;
      return api<T>('get_snapshot', {base});
    }
    case 'stage_all': {
      snapshot = {...snapshot, files:snapshot.files.map(f=>({...f,staged:!!params.staged}))};
      snapshot.stagedCount = snapshot.files.filter(f=>f.staged).length;
      return api<T>('get_snapshot', {base});
    }
    case 'commit': {
      snapshot = {...snapshot, files:snapshot.files.filter(f=>!f.staged), stagedCount:0};
      result = {message:'Demo commit created. Your local repositories were not changed.'}; break;
    }
    case 'get_connection': result = {command:'patchwork',args:['--mcp'],clients:[],available:false}; break;
    default: throw new Error(`Unknown action: ${method}`);
  }
  return structuredClone(result) as T;
}
