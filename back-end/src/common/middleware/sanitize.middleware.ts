import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

const MUTATIONS = ['POST', 'PATCH', 'PUT'];
/** Null bytes and C0/C1 controls, keeping tab, newline and carriage return. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/**
 * A complete tag, not any `<`.
 *
 * Two earlier attempts were too greedy on a platform where people write about
 * code: `<[^>]*>` turned `3 < 5 and a > b` into `3  b.`, and making the closing
 * bracket optional ate `Use x<y for the bound` down to `Use x`. Requiring a tag
 * name after the `<` **and** a closing `>` with no `<` in between keeps
 * comparisons, `<3` and unclosed angle brackets intact, while still removing
 * `<img …>`, `</div>` and `<svg onload=…>`.
 *
 * A truncated `<script` with no `>` survives this, which is why output
 * escaping stays in place rather than being replaced by it.
 */
const TAGS = /<[/!?]?[a-zA-Z][^<>]*>/g;

/**
 * Fields whose value must survive byte-for-byte. A password may legitimately
 * contain `<`, and trimming or rewriting one silently breaks the login it was
 * chosen for.
 */
const VERBATIM = new Set(['password', 'confirmPassword', 'token', 'authorization']);

/**
 * Strips markup and control characters from incoming text.
 *
 * The output side is where escaping belongs, and it is applied — but this
 * frontend builds ~52 pages of HTML by hand in template strings, with no
 * framework doing it automatically. Sweeping every sink was tried twice and
 * missed most of them: the interpolations take too many shapes to match
 * reliably, and one missed sink is a live vulnerability. A worker's deliverable
 * notes were executing script in the client's browser, and a client's dispute
 * reason in a superuser's.
 *
 * So markup is refused at the door as well. Nothing in this platform accepts
 * rich text — every field is plain prose, a name, a URL or a number — which is
 * what makes stripping safe here rather than lossy. Output escaping stays as
 * the second layer; neither is trusted alone.
 */
@Injectable()
export class SanitizeMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    if (MUTATIONS.includes(req.method) && req.body && typeof req.body === 'object') {
      req.body = clean(req.body, 0);
    }
    next();
  }
}

function cleanString(value: string): string {
  let out = value.replace(CONTROL_CHARS, '');
  // Repeat until stable: `<scr<x>ipt>` collapses to `<script>` on one pass.
  let previous;
  do {
    previous = out;
    out = out.replace(TAGS, '');
  } while (out !== previous);
  return out.trim();
}

function clean(value: any, depth: number, key?: string): any {
  // Bounded so a deeply nested body cannot blow the stack here.
  if (depth > 12) return value;
  if (typeof value === 'string') return key && VERBATIM.has(key) ? value : cleanString(value);
  if (Array.isArray(value)) return value.map(v => clean(v, depth + 1, key));
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = clean(v, depth + 1, k);
    return out;
  }
  return value;
}
