import { Injectable, NestMiddleware, ForbiddenException, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * `POST /seed/reset` destroys every record and every uploaded file.
 *
 * It is one authenticated call away, and the role that can make it is held by
 * staff who have no reason to wipe production. The guard is the environment,
 * not the caller: outside development the endpoint simply does not work.
 */
@Injectable()
export class SeedGuardMiddleware implements NestMiddleware {
  private readonly logger = new Logger('SeedGuard');

  use(req: Request, _res: Response, next: NextFunction) {
    if (process.env.NODE_ENV === 'production') {
      this.logger.error(`refused ${req.method} ${req.originalUrl} — seed reset is disabled in production`);
      throw new ForbiddenException(
        'Seeding is disabled in production. This endpoint destroys all data and is available only in development.',
      );
    }
    next();
  }
}
