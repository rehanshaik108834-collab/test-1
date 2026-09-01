import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AppLoggerService } from '../logging/app-logger.service';

/**
 * Logs access to the financial surfaces — reads included.
 *
 * Unlike the money trail, a plain `GET` matters here: who looked at platform
 * revenue, or at the fee configuration, is itself worth recording. With more
 * than one admin account this is the only thing that says which of them acted.
 */
@Injectable()
export class AdminAuditMiddleware implements NestMiddleware {
  constructor(private readonly log: AppLoggerService) {}

  use(req: Request, res: Response, next: NextFunction) {
    res.on('finish', () => {
      const verb = req.method === 'GET' ? 'read' : 'changed';
      // AppLoggerService already prefixes the id and the actor.
      this.log.log('admin.audit', `${verb} ${req.originalUrl} -> ${res.statusCode}`);
    });
    next();
  }
}
