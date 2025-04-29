import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as CryptoJS from 'crypto-js';
import { env } from 'process';

@Injectable()
export class EncryptionService implements OnModuleInit {
  private secretKey: string;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const secret = this.configService.get<string>('CREDENTIALS_ENCRYPTION_SECRET');

    // Check if the secret is actually retrieved and not the placeholder
    if (!secret || secret === 'Mb/GEE0A5LmhcxWj+qgzZoyvNFKRAzAOzrmUSLJp1hw=') { // Check against the original placeholder value too
      console.error(
        'ERROR: CREDENTIALS_ENCRYPTION_SECRET is not set or is using the default placeholder. Please generate a strong secret key and set it in the .env file.',
      );
      // In production, you should always throw an error.
      throw new Error('CREDENTIALS_ENCRYPTION_SECRET must be set in environment variables.');
    }

    // If the check passes, assign the guaranteed string value
    this.secretKey = secret;
    this.checkSecretKeyStrength(this.secretKey); // Optional: Add a strength check
  }

  // Optional: Add a helper to check key strength (basic example)
  private checkSecretKeyStrength(key: string) {
    if (key.length < 32) { // Example minimum length check
        console.warn('WARNING: CREDENTIALS_ENCRYPTION_SECRET appears weak. Consider using a longer, more random key.');
    }
    // You could add checks for character variety, etc.
  }

  /**
   * Encrypts a JSON object.
   * @param data The object to encrypt.
   * @returns Encrypted string (Base64 encoded).
   */
  encrypt(data: Record<string, any>): string {
    if (!this.secretKey) {
      throw new Error('Encryption secret key is not initialized.');
    }
    const jsonString = JSON.stringify(data);
    const encrypted = CryptoJS.AES.encrypt(jsonString, this.secretKey).toString();
    // Return Base64 representation for easier storage in JSONB
    return Buffer.from(encrypted).toString('base64'); 
  }

  /**
   * Decrypts a Base64 encoded string back into a JSON object.
   * @param encryptedDataBase64 The Base64 encoded encrypted string.
   * @returns The decrypted object.
   */
  decrypt<T = Record<string, any>>(encryptedDataBase64: string): T {
    if (!this.secretKey) {
      throw new Error('Encryption secret key is not initialized.');
    }
    try {
      // Decode Base64 first
      const encryptedData = Buffer.from(encryptedDataBase64, 'base64').toString('utf-8');
      const bytes = CryptoJS.AES.decrypt(encryptedData, this.secretKey);
      const jsonString = bytes.toString(CryptoJS.enc.Utf8);
      if (!jsonString) {
          throw new Error('Decryption failed: Empty result after decryption.');
      }
      return JSON.parse(jsonString) as T;
    } catch (error) {
      console.error('Decryption failed:', error);
      // Handle potential errors: incorrect key, corrupted data, non-JSON result
      throw new Error(`Failed to decrypt or parse credentials. Error: ${error.message}`);
    }
  }
}
