import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'debug', 'log', 'verbose'], // Enable all log levels
    bufferLogs: true, // Buffer logs until logger is ready
  });
  
  const logger = new Logger('Bootstrap'); // Initialize logger early for potential port parsing warnings
  
  // Set global prefix for all routes (optional)
  app.setGlobalPrefix('api');
  
  // Enable CORS if needed
  app.enableCors();
  
  const portEnv = process.env.PORT;
  let port = 3000; // Default port
  if (portEnv) {
    const parsedPort = parseInt(portEnv, 10);
    if (isNaN(parsedPort)) {
      logger.warn(`Invalid PORT environment variable: "${portEnv}". Defaulting to port ${port}.`);
    } else {
      port = parsedPort;
    }
  } else {
    logger.log(`PORT environment variable not set. Defaulting to port ${port}.`);
  }
  
  const host = '0.0.0.0'; // Listen on all available network interfaces

  await app.listen(port, host);
  
  // getUrl() will give the correct address based on host/port
  logger.log(`Application is listening on: ${await app.getUrl()}`); 
  logger.log(`Server is listening on host ${host} and port ${port}`);
  logger.debug('Debug logging is enabled');
}
bootstrap();
