import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { getContext, shortId } from '../logging/request-context';

declare module 'express-serve-static-core' {
  interface Request {
    user?: { id: string; role: string; email?: string; via: 'token' | 'header' };
  }
}

/**
 * Resolves who is making the request.
 *
 * A verified bearer token wins. When there is no token the old `role` /
 * `user-id` headers are still honoured — this is a migration step, chosen so
 * the transition does not break every page at once, and it **does not close
 * the hole**: a caller who simply omits the token still gets in on headers.
 *
 * What it does do is make the remaining exposure measurable. Every fallback
 * logs the route it happened on, so `grep 'auth.fallback'` counts exactly how
 * much still depends on headers. Deleting the fallback later is one branch.
 *
 * This stage only *identifies*. It does not refuse an anonymous request —
 * enforcement is the router-level middleware stage, so that the change which
 * takes access away lands on its own.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Auth');
  /** One line per route per process, or a busy dashboard floods the log. */
  private readonly reported = new Set<string>();

  constructor(private readonly auth: AuthService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const header = req.get('authorization') || '';
    const token = header.replace(/^Bearer\s+/i, '').trim();

    if (token) {
      const claims = this.auth.verify(token);
      if (claims) {
        req.user = { id: claims.sub, role: claims.role, email: claims.email, via: 'token' };
        // The token is the authority, so the request is made to agree with it.
        // Twenty handlers across six controllers read identity from these two
        // headers; rewriting them here means a signed token beats whatever the
        // caller typed, everywhere, without each of those reads changing.
        req.headers['role'] = claims.role;
        req.headers['user-id'] = claims.sub;
        this.syncContext(req);
        return next();
      }
      // A token that was sent and did not verify is worth a line: expired,
      // tampered with, or signed by a previous process.
      this.logger.warn(`[${shortId(req.id)}] rejected an invalid bearer token on ${req.method} ${req.originalUrl}`);
    }

    const role = req.get('role');
    const userId = req.get('user-id');
    if (role) {
      req.user = { id: userId || '', role, via: 'header' };
      this.noteFallback(req);
    }

    this.syncContext(req);
    next();
  }

  /** Keeps the log context aligned with whoever the token says this is. */
  private syncContext(req: Request) {
    const ctx = getContext();
    if (!ctx || !req.user) return;
    ctx.userId = req.user.id || ctx.userId;
    ctx.role = req.user.role || ctx.role;
  }

  private noteFallback(req: Request) {
    const route = `${req.method} ${req.route?.path || req.originalUrl.split('?')[0]}`;
    if (this.reported.has(route)) return;
    this.reported.add(route);
    this.logger.warn(`auth.fallback — ${route} identified by the role header, with no bearer token`);
  }
}
