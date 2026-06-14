import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SALT = 'multi_llm_orchestrator_salt_constant'; // Static salt for key derivation

/**
 * Derives a robust 32-byte key from the configured passphrase.
 */
function getDerivedKey(passphrase: string): Buffer {
  return crypto.scryptSync(passphrase, SALT, 32);
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a colon-separated string: iv:authTag:encryptedText
 */
export function encrypt(plaintext: string, secretKey: string): string {
  const key = getDerivedKey(secretKey);
  const iv = crypto.randomBytes(12); // 12-byte IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an encrypted string (iv:authTag:encryptedText) using AES-256-GCM.
 */
export function decrypt(ciphertext: string, secretKey: string): string {
  const key = getDerivedKey(secretKey);
  const parts = ciphertext.split(':');
  
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format. Expected iv:authTag:ciphertext');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
