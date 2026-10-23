import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';

const CHUNK_BYTES = 64 * 1024;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const RECORD_OVERHEAD = NONCE_BYTES + TAG_BYTES;

/** Ephemeral scratch: keys never leave this process and every disk record is authenticated ciphertext. */
export class EncryptedMediaFile {
  private readonly pending = Buffer.alloc(CHUNK_BYTES);
  private pendingBytes = 0;
  private records = 0;
  private plaintextBytes = 0;
  private finished = false;
  private disposed = false;
  private disposing?: Promise<void>;
  private readonly readers = new Set<Readable>();
  private constructor(private readonly file: FileHandle, private readonly key: Buffer) {}

  public static async create(filename: string): Promise<EncryptedMediaFile> {
    const key = randomBytes(32);
    try { return new EncryptedMediaFile(await open(filename, 'wx+', 0o600), key); }
    catch (error) { key.fill(0); throw error; }
  }
  public get size(): number { return this.plaintextBytes; }
  public get diskBytes(): number { return this.plaintextBytes + this.records * RECORD_OVERHEAD; }

  public async append(bytes: Uint8Array): Promise<void> {
    if (this.disposed || this.finished) throw new Error('Encrypted media is not writable.');
    let offset = 0;
    while (offset < bytes.byteLength) {
      const length = Math.min(CHUNK_BYTES - this.pendingBytes, bytes.byteLength - offset);
      this.pending.set(bytes.subarray(offset, offset + length), this.pendingBytes);
      this.pendingBytes += length; offset += length; this.plaintextBytes += length;
      if (this.pendingBytes === CHUNK_BYTES) await this.flush();
    }
  }
  private async flush(): Promise<void> {
    if (!this.pendingBytes) return;
    await this.writeRecord(this.records, this.pending.subarray(0, this.pendingBytes));
    this.records++;
    this.pending.fill(0); this.pendingBytes = 0;
  }
  public async finish(): Promise<void> {
    if (this.disposed) throw new Error('Encrypted media is disposed.');
    if (!this.finished) { await this.flush(); await this.file.sync(); this.finished = true; }
  }
  private aad(index: number, length: number): Buffer {
    const value = Buffer.alloc(16);
    value.write('RCM1', 0, 'ascii'); value.writeBigUInt64BE(BigInt(index), 4); value.writeUInt32BE(length, 12);
    return value;
  }
  private async writeRecord(index: number, plaintext: Buffer): Promise<void> {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(this.aad(index, plaintext.length));
    const encrypted = Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    let written = 0;
    while (written < encrypted.length) {
      const result = await this.file.write(encrypted, written, encrypted.length - written, index * (CHUNK_BYTES + RECORD_OVERHEAD) + written);
      if (!result.bytesWritten) throw new Error('Encrypted media write made no progress.');
      written += result.bytesWritten;
    }
  }
  private async readRecord(index: number): Promise<Buffer> {
    if (!this.finished || this.disposed || index < 0 || index >= this.records) throw new Error('Encrypted media record is unavailable.');
    const length = Math.min(CHUNK_BYTES, this.size - index * CHUNK_BYTES);
    const encrypted = Buffer.alloc(length + RECORD_OVERHEAD);
    let read = 0;
    while (read < encrypted.length) {
      const result = await this.file.read(encrypted, read, encrypted.length - read, index * (CHUNK_BYTES + RECORD_OVERHEAD) + read);
      if (!result.bytesRead) throw new Error('Encrypted media record is truncated.');
      read += result.bytesRead;
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(0, NONCE_BYTES));
    decipher.setAAD(this.aad(index, length));
    decipher.setAuthTag(encrypted.subarray(encrypted.length - TAG_BYTES));
    const plaintext = decipher.update(encrypted.subarray(NONCE_BYTES, encrypted.length - TAG_BYTES));
    try { decipher.final(); return plaintext; }
    catch (error) { plaintext.fill(0); throw error; }
  }
  /** Bounded random reads/patches support RIFF sizes without ever decrypting a filesystem file. */
  public async read(offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > CHUNK_BYTES || offset + length > this.size) throw new Error('Invalid encrypted media read.');
    const result = Buffer.alloc(length);
    let copied = 0;
    while (copied < length) {
      const position = offset + copied;
      const record = await this.readRecord(Math.floor(position / CHUNK_BYTES));
      try { const count = Math.min(record.length - position % CHUNK_BYTES, length - copied); record.copy(result, copied, position % CHUNK_BYTES, position % CHUNK_BYTES + count); copied += count; }
      finally { record.fill(0); }
    }
    return result;
  }
  public async patch(offset: number, bytes: Uint8Array): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0 || bytes.length > CHUNK_BYTES || offset + bytes.length > this.size) throw new Error('Invalid encrypted media patch.');
    let copied = 0;
    while (copied < bytes.length) {
      const position = offset + copied;
      const index = Math.floor(position / CHUNK_BYTES);
      const record = await this.readRecord(index);
      try {
        const count = Math.min(record.length - position % CHUNK_BYTES, bytes.length - copied);
        record.set(bytes.subarray(copied, copied + count), position % CHUNK_BYTES);
        await this.writeRecord(index, record); // Fresh nonce for every rewrite.
        copied += count;
      } finally { record.fill(0); }
    }
  }
  public openStream(): ReadableStream<Uint8Array> {
    if (!this.finished || this.disposed) throw new Error('Encrypted media stream is unavailable.');
    const self = this;
    const reader = Readable.from((async function* () {
      if ((await self.file.stat()).size !== self.diskBytes) throw new Error('Encrypted media length changed.');
      for (let index = 0; index < self.records; index++) yield await self.readRecord(index);
      if ((await self.file.stat()).size !== self.diskBytes) throw new Error('Encrypted media length changed.');
    })(), { objectMode: false, highWaterMark: CHUNK_BYTES });
    this.readers.add(reader); reader.once('close', () => this.readers.delete(reader));
    return Readable.toWeb(reader, { strategy: { highWaterMark: CHUNK_BYTES, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream<Uint8Array>;
  }
  public dispose(): Promise<void> {
    if (!this.disposing) {
      this.disposed = true;
      this.disposing = (async () => {
        try {
          await Promise.all([...this.readers].map(reader => new Promise<void>(resolve => { reader.once('close', resolve); reader.destroy(); })));
          await this.file.close();
        } finally { this.key.fill(0); this.pending.fill(0); }
      })();
    }
    return this.disposing;
  }
}
