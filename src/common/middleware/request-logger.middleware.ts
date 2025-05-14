import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('RequestLogger');

  use(req: Request, res: Response, next: NextFunction) {
    const startTime = Date.now();
    const { method, originalUrl, query, body, headers } = req;
    const userAgent = headers['user-agent'];
    const userId = headers['x-user-id'] || 'unknown';
    const requestId = Math.random().toString(36).substring(7);

    // Log request
    this.logger.log(
      `[${requestId}] [${method}] ${originalUrl}` +
      `\nUser: ${userId}` +
      `\nUA: ${userAgent}` +
      `\nQuery: ${JSON.stringify(query)}` +
      `\nBody: ${JSON.stringify(body)}` +
      `\nHeaders: ${JSON.stringify({
        'content-type': headers['content-type'],
        'authorization': headers['authorization'] ? 'Bearer ***' : undefined,
        'x-forwarded-for': headers['x-forwarded-for'],
        'x-real-ip': headers['x-real-ip']
      })}`
    );

    // Log response
    const originalSend = res.send;
    res.send = function (body) {
      const duration = Date.now() - startTime;
      this.logger.log(
        `[${requestId}] [${method}] ${originalUrl} - Status: ${res.statusCode} - Duration: ${duration}ms` +
        `\nResponse: ${typeof body === 'string' ? body : JSON.stringify(body)}`
      );
      return originalSend.call(this, body);
    };

    next();
  }
} 