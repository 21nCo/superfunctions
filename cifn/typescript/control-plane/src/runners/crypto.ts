import crypto from 'crypto';

export function generateRunnerSecret(): string {
  return `rs_${crypto.randomBytes(32).toString('hex')}`;
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function compareSecretHash(secret: string, hash: string): boolean {
  const secretHash = hashSecret(secret);
  return crypto.timingSafeEqual(Buffer.from(secretHash), Buffer.from(hash));
}
