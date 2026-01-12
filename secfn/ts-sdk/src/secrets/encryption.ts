import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';

export interface EncryptedData {
  iv: string;
  encrypted: string;
  authTag: string;
}

export class SecretEncryption {
  private algorithm = 'aes-256-gcm';
  private keyLength = 32;
  private ivLength = 16;
  private salt = 'secfn-salt-v1';
  private iterations = 100000;

  async encrypt(plaintext: string, masterKey: string): Promise<string> {
    const key = this.deriveKey(masterKey);
    const iv = randomBytes(this.ivLength);
    const cipher = createCipheriv(this.algorithm, key, iv) as any;

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    const data: EncryptedData = {
      iv: iv.toString('hex'),
      encrypted,
      authTag: authTag.toString('hex'),
    };

    return JSON.stringify(data);
  }

  async decrypt(ciphertext: string, masterKey: string): Promise<string> {
    const key = this.deriveKey(masterKey);
    const data: EncryptedData = JSON.parse(ciphertext);

    const decipher = createDecipheriv(
      this.algorithm,
      key,
      Buffer.from(data.iv, 'hex')
    ) as any;
    decipher.setAuthTag(Buffer.from(data.authTag, 'hex'));

    let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  private deriveKey(masterKey: string): Buffer {
    return pbkdf2Sync(
      masterKey,
      this.salt,
      this.iterations,
      this.keyLength,
      'sha256'
    );
  }

  isEncrypted(value: string): boolean {
    try {
      const parsed = JSON.parse(value);
      return (
        typeof parsed === 'object' &&
        'iv' in parsed &&
        'encrypted' in parsed &&
        'authTag' in parsed
      );
    } catch {
      return false;
    }
  }
}
