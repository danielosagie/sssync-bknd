import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'debug', 'log', 'verbose'], // Enable all log levels
    bufferLogs: true, // Buffer logs until logger is ready
  });
  
  // Set global prefix for all routes (optional)
  app.setGlobalPrefix('api');
  
  // Enable CORS if needed
  app.enableCors();
  
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  
  const logger = new Logger('Bootstrap');
  logger.log(`Application is running on: http://localhost:${port}`);
  logger.debug('Debug logging is enabled');
}
bootstrap();
