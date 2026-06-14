import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.ts';
import { encrypt, decrypt } from './encryption.ts';

/**
 * Manages loading and saving of encrypted Playwright session files.
 */
export class SessionManager {
  private static getSessionFilePath(providerId: string): string {
    return path.join(config.sessionStorageDir, `${providerId}.json.enc`);
  }

  /**
   * Loads and decrypts a provider session directly into memory.
   * Returns null if no session exists yet.
   */
  public static async loadSession(providerId: string): Promise<any | null> {
    const filePath = this.getSessionFilePath(providerId);
    try {
      // Check if encrypted session exists
      await fs.access(filePath);
      const encryptedData = await fs.readFile(filePath, 'utf8');
      
      const decryptedData = decrypt(encryptedData, config.encryptionKey);
      return JSON.parse(decryptedData);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // No session exists yet
        return null;
      }
      throw new Error(`Failed to load session for ${providerId}: ${error.message}`);
    }
  }

  /**
   * Encrypts and saves a provider session to disk.
   */
  public static async saveSession(providerId: string, storageState: any): Promise<void> {
    const filePath = this.getSessionFilePath(providerId);
    try {
      // Ensure storage directory exists
      await fs.mkdir(config.sessionStorageDir, { recursive: true });

      const plaintext = JSON.stringify(storageState);
      const encryptedData = encrypt(plaintext, config.encryptionKey);

      await fs.writeFile(filePath, encryptedData, 'utf8');
    } catch (error: any) {
      throw new Error(`Failed to save session for ${providerId}: ${error.message}`);
    }
  }

  /**
   * Check if session exists
   */
  public static async hasSession(providerId: string): Promise<boolean> {
    const filePath = this.getSessionFilePath(providerId);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
