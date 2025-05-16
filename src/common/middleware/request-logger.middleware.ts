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

    // Capture the logger instance from the middleware class
    const middlewareLogger = this.logger;

    // Log request details
    middlewareLogger.log(
      `[${requestId}] [${method}] ${originalUrl}` +
      `\nUser: ${userId}` +
      `\nUA: ${userAgent}` +
      `\nQuery: ${JSON.stringify(query)}` +
      `\nHeaders: ${JSON.stringify({
        'content-type': headers['content-type'],
        'authorization': headers['authorization'] ? 'Bearer ***' : undefined,
        'x-forwarded-for': headers['x-forwarded-for'],
        'x-real-ip': headers['x-real-ip']
      })}`
    );

    // Detailed logging for media.imageUris
    if (body && typeof body === 'object' && body.media && Array.isArray(body.media.imageUris)) {
      middlewareLogger.log(`[${requestId}] req.body.media.imageUris (type: ${typeof body.media.imageUris}, length: ${body.media.imageUris.length}):`);
      body.media.imageUris.forEach((uri, index) => {
        middlewareLogger.log(`[${requestId}]   [${index}] (type: ${typeof uri}): "${uri}"`);
      });
    } else if (body && typeof body === 'object' && body.media) {
      middlewareLogger.log(`[${requestId}] req.body.media exists, but imageUris is not an array. Value: ${JSON.stringify(body.media.imageUris)}`);
    } else if (body && typeof body === 'object') {
      middlewareLogger.log(`[${requestId}] req.body.media does not exist or is not an object.`);
    } else {
      middlewareLogger.log(`[${requestId}] req.body is not an object or is null/undefined. Type: ${typeof body}, Value: ${body}`);
    }
    
    // Log the full body as before for general context
    middlewareLogger.log(`[${requestId}] Full req.body stringified: ${JSON.stringify(body)}`);

    // Monkey-patch res.send to log response details
    const originalSend = res.send;
    res.send = function (responseBody) { // Renamed `body` to `responseBody` for clarity
      const duration = Date.now() - startTime;
      // Use the captured logger instance
      middlewareLogger.log(
        `[${requestId}] [${method}] ${originalUrl} - Status: ${res.statusCode} - Duration: ${duration}ms` +
        `\nResponse: ${typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)}`
      );
      // Call the original res.send method with the correct context and arguments
      return originalSend.call(this, responseBody);
    };

    next();
  }
}