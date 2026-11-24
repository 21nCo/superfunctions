import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
  createImageTransformProcessor,
  createThumbnailProcessor,
  createPdfPreviewProcessor,
  createCompressionProcessor,
  supportsProcessor,
  THUMBNAIL_SUPPORTED_MIME_TYPES,
  PDF_PREVIEW_SUPPORTED_MIME_TYPES,
  COMPRESSION_SUPPORTED_MIME_TYPES,
} from '../src/index.js';
import { CONTENT_TYPE_MISMATCH_ERROR, assertRasterImage, contentMatchesDeclaredType, ffmpegInputArgs, pdfStart } from '../src/content-sniff.js';
import { createTesseractJsOCRProvider } from '../src/providers/tesseract-ocr.js';

async function createTestImage(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

describe('@filefn/processing', () => {
  describe('Processor contracts', () => {
    it('should export Processor-compatible thumbnail processor', () => {
      const processor = createThumbnailProcessor();
      expect(processor).toBeDefined();
      expect(processor.name).toBe('thumbnail');
      expect(processor.supportedMimeTypes).toEqual(THUMBNAIL_SUPPORTED_MIME_TYPES);
      expect(typeof processor.process).toBe('function');
    });

    it('should export Processor-compatible compression processor', () => {
      const processor = createCompressionProcessor();
      expect(processor).toBeDefined();
      expect(processor.name).toBe('compression');
      expect(processor.supportedMimeTypes).toEqual(COMPRESSION_SUPPORTED_MIME_TYPES);
      expect(typeof processor.process).toBe('function');
    });

    it('should export Processor-compatible PDF preview processor', () => {
      const processor = createPdfPreviewProcessor();
      expect(processor).toBeDefined();
      expect(processor.name).toBe('pdf-preview');
      expect(processor.supportedMimeTypes).toEqual(PDF_PREVIEW_SUPPORTED_MIME_TYPES);
      expect(typeof processor.process).toBe('function');
    });
  });

  describe('supportsProcessor', () => {
    it('should match specific MIME types', () => {
      const processor = createThumbnailProcessor();
      expect(supportsProcessor(processor, 'image/png')).toBe(true);
      expect(supportsProcessor(processor, 'image/jpeg')).toBe(true);
      expect(supportsProcessor(processor, 'image/webp')).toBe(true);
      expect(supportsProcessor(processor, 'application/pdf')).toBe(false);
    });

    it('should match wildcard MIME types', () => {
      const processor = createCompressionProcessor();
      expect(supportsProcessor(processor, 'image/png')).toBe(true);
      expect(supportsProcessor(processor, 'application/json')).toBe(true);
      expect(supportsProcessor(processor, 'text/plain')).toBe(true);
    });
  });

  describe('ThumbnailProcessor', () => {
    it('should reject unsupported MIME types', async () => {
      const processor = createThumbnailProcessor();
      const getData = vi.fn();

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/document.pdf',
          mimeType: 'application/pdf',
          size: 1000,
          fileName: 'document.pdf',
        },
        getData
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('FILEFN_PROCESSING_UNSUPPORTED_MIME_TYPE');
      expect(getData).not.toHaveBeenCalled();
    });

    it('should generate real thumbnail artifacts for PNG images', async () => {
      const processor = createThumbnailProcessor({
        sizes: [
          { name: 'small', width: 100, height: 100 },
          { name: 'large', width: 400, height: 400 },
        ],
        quality: 80,
        format: 'jpeg',
      });

      const testImage = await createTestImage(800, 600);
      const getData = vi.fn().mockResolvedValue(testImage);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/image.png',
          mimeType: 'image/png',
          size: testImage.length,
          fileName: 'image.png',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(2);

      const smallThumb = result.artifacts[0];
      expect(smallThumb.kind).toBe('thumbnail-small');
      expect(smallThumb.mimeType).toBe('image/jpeg');
      expect(smallThumb.storageKey).toContain('-thumb-small.jpg');
      expect(smallThumb.data.length).toBeGreaterThan(0);

      const smallMeta = await sharp(Buffer.from(smallThumb.data)).metadata();
      expect(smallMeta.width).toBeLessThanOrEqual(100);
      expect(smallMeta.height).toBeLessThanOrEqual(100);

      const largeThumb = result.artifacts[1];
      expect(largeThumb.kind).toBe('thumbnail-large');
      expect(largeThumb.mimeType).toBe('image/jpeg');

      const largeMeta = await sharp(Buffer.from(largeThumb.data)).metadata();
      expect(largeMeta.width).toBeLessThanOrEqual(400);
      expect(largeMeta.height).toBeLessThanOrEqual(400);

      expect(getData).toHaveBeenCalledOnce();
    });

    it('should preserve aspect ratio (fit inside)', async () => {
      const processor = createThumbnailProcessor({
        sizes: [{ name: 'thumb', width: 100, height: 100 }],
      });

      const wideImage = await createTestImage(1000, 500);
      const getData = vi.fn().mockResolvedValue(wideImage);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/wide.png',
          mimeType: 'image/png',
          size: wideImage.length,
          fileName: 'wide.png',
        },
        getData
      );

      expect(result.success).toBe(true);
      const meta = await sharp(Buffer.from(result.artifacts[0].data)).metadata();
      expect(meta.width).toBe(100);
      expect(meta.height).toBe(50);
    });

    it('should not enlarge small images', async () => {
      const processor = createThumbnailProcessor({
        sizes: [{ name: 'thumb', width: 500, height: 500 }],
      });

      const smallImage = await createTestImage(100, 100);
      const getData = vi.fn().mockResolvedValue(smallImage);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/small.png',
          mimeType: 'image/png',
          size: smallImage.length,
          fileName: 'small.png',
        },
        getData
      );

      expect(result.success).toBe(true);
      const meta = await sharp(Buffer.from(result.artifacts[0].data)).metadata();
      expect(meta.width).toBe(100);
      expect(meta.height).toBe(100);
    });

    it('should support webp output format', async () => {
      const processor = createThumbnailProcessor({
        sizes: [{ name: 'thumb', width: 100, height: 100 }],
        format: 'webp',
        quality: 90,
      });

      const testImage = await createTestImage(400, 400);
      const getData = vi.fn().mockResolvedValue(testImage);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/image.png',
          mimeType: 'image/png',
          size: testImage.length,
          fileName: 'image.png',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts[0].mimeType).toBe('image/webp');
      expect(result.artifacts[0].storageKey).toContain('.webp');

      const meta = await sharp(Buffer.from(result.artifacts[0].data)).metadata();
      expect(meta.format).toBe('webp');
    });

    it('should support png output format', async () => {
      const processor = createThumbnailProcessor({
        sizes: [{ name: 'thumb', width: 100, height: 100 }],
        format: 'png',
      });

      const testImage = await createTestImage(400, 400);
      const getData = vi.fn().mockResolvedValue(testImage);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/image.jpg',
          mimeType: 'image/jpeg',
          size: testImage.length,
          fileName: 'image.jpg',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts[0].mimeType).toBe('image/png');
      expect(result.artifacts[0].storageKey).toContain('.png');
    });

    it('should include metadata in artifact output', async () => {
      const processor = createThumbnailProcessor({
        sizes: [{ name: 'small', width: 150, height: 150 }],
        quality: 75,
        format: 'jpeg',
      });

      const testImage = await createTestImage(600, 400);
      const getData = vi.fn().mockResolvedValue(testImage);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/photo.jpg',
          mimeType: 'image/jpeg',
          size: testImage.length,
          fileName: 'photo.jpg',
        },
        getData
      );

      expect(result.success).toBe(true);
      const artifact = result.artifacts[0];
      expect(artifact.metadata).toMatchObject({
        width: 150,
        height: 150,
        quality: 75,
        format: 'jpeg',
        sourceFileId: 'file_001',
        sourceVersionId: 'ver_001',
      });
      expect(artifact.metadata?.originalSize).toBe(testImage.length);
      expect(artifact.metadata?.thumbnailSize).toBe(artifact.data.length);
    });
  });

  describe('CompressionProcessor', () => {
    it('should compress data using gzip by default', async () => {
      const processor = createCompressionProcessor();

      const testData = new Uint8Array(1000);
      testData.fill(65);
      const getData = vi.fn().mockResolvedValue(testData);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/data.txt',
          mimeType: 'text/plain',
          size: testData.length,
          fileName: 'data.txt',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts.length).toBe(1);
      expect(result.artifacts[0].kind).toBe('compressed-gzip');
      expect(result.artifacts[0].mimeType).toBe('application/gzip');
      expect(result.artifacts[0].storageKey).toBe('test/data.txt.gz');
      expect(result.artifacts[0].data.length).toBeLessThan(testData.length);

      expect(result.artifacts[0].metadata).toMatchObject({
        algorithm: 'gzip',
        originalSize: 1000,
      });
      expect(result.artifacts[0].metadata?.compressedSize).toBe(result.artifacts[0].data.length);
    });

    it('should skip compression if ratio is too low (incompressible data)', async () => {
      const processor = createCompressionProcessor();

      const randomData = new Uint8Array(100);
      for (let i = 0; i < randomData.length; i++) {
        randomData[i] = Math.floor(Math.random() * 256);
      }
      const getData = vi.fn().mockResolvedValue(randomData);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/random.bin',
          mimeType: 'application/octet-stream',
          size: randomData.length,
          fileName: 'random.bin',
        },
        getData
      );

      expect(result.success).toBe(true);
    });

    it('should use deflate when configured', async () => {
      const processor = createCompressionProcessor({ algorithm: 'deflate' });

      const testData = new Uint8Array(1000);
      testData.fill(66);
      const getData = vi.fn().mockResolvedValue(testData);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/data.txt',
          mimeType: 'text/plain',
          size: testData.length,
          fileName: 'data.txt',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts.length).toBe(1);
      expect(result.artifacts[0].kind).toBe('compressed-deflate');
      expect(result.artifacts[0].storageKey).toBe('test/data.txt.deflate');
    });

    it('should respect compression level', async () => {
      const lowCompression = createCompressionProcessor({ level: 1 });
      const highCompression = createCompressionProcessor({ level: 9 });

      const testData = new Uint8Array(10000);
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 100;
      }

      const lowResult = await lowCompression.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/data.bin',
          mimeType: 'application/octet-stream',
          size: testData.length,
          fileName: 'data.bin',
        },
        async () => testData
      );

      const highResult = await highCompression.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/data.bin',
          mimeType: 'application/octet-stream',
          size: testData.length,
          fileName: 'data.bin',
        },
        async () => testData
      );

      expect(lowResult.success).toBe(true);
      expect(highResult.success).toBe(true);
      expect(lowResult.artifacts).toHaveLength(1);
      expect(highResult.artifacts).toHaveLength(1);
      expect(highResult.artifacts[0].data.length).toBeLessThanOrEqual(lowResult.artifacts[0].data.length);
    });
  });

  describe('PdfPreviewProcessor', () => {
    it('should reject unsupported MIME types with a stable error code', async () => {
      const processor = createPdfPreviewProcessor();

      const result = await processor.process(
        {
          fileId: 'file_002',
          versionId: 'ver_002',
          storageKey: 'test/image.png',
          mimeType: 'image/png',
          size: 128,
          fileName: 'image.png',
        },
        vi.fn(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('FILEFN_PROCESSING_UNSUPPORTED_MIME_TYPE');
    });

    it('should emit canonical PDF preview kinds even when rasterization falls back to placeholders', async () => {
      const processor = createPdfPreviewProcessor();
      const invalidPdf = new TextEncoder().encode('not-a-real-pdf');
      const getData = vi.fn().mockResolvedValue(invalidPdf);

      const result = await processor.process(
        {
          fileId: 'file_pdf_001',
          versionId: 'ver_pdf_001',
          storageKey: 'test/report.pdf',
          mimeType: 'application/pdf',
          size: invalidPdf.length,
          fileName: 'report.pdf',
        },
        getData,
      );

      expect(result.success).toBe(true);
      expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
        'pdf-preview-page-1-small',
        'pdf-preview-page-1-medium',
        'pdf-preview-page-1-large',
      ]);
      expect(result.artifacts.every((artifact) => artifact.mimeType === 'image/png')).toBe(true);
      expect(result.artifacts.every((artifact) => artifact.storageKey.includes('-pdf-preview-page-1-'))).toBe(true);
      expect(result.artifacts.every((artifact) => artifact.metadata?.pageNumber === 1)).toBe(true);
      expect(result.artifacts.every((artifact) => artifact.metadata?.renderMode)).toBe(true);
      expect(result.artifacts.every((artifact) => artifact.data.length > 0)).toBe(true);
      expect(getData).toHaveBeenCalledOnce();
    });

    it('should surface a stable error code when input retrieval fails', async () => {
      const processor = createPdfPreviewProcessor();

      const result = await processor.process(
        {
          fileId: 'file_pdf_002',
          versionId: 'ver_pdf_002',
          storageKey: 'test/broken.pdf',
          mimeType: 'application/pdf',
          size: 0,
          fileName: 'broken.pdf',
        },
        vi.fn().mockRejectedValue(new Error('boom')),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('FILEFN_PROCESSING_PDF_PREVIEW_FAILED');
    });
  });

  describe('artifact keys stay inside the source key (FILE-30 F-06)', () => {
    // P10: tenant `acme.com`, extensionless file names. The old /\.[^.]+$/ matched
    // from the dot in the tenant across `/`, so every such file's thumbnails
    // collapsed onto `acme-thumb-small.jpg`.
    const sources = [
      { fileId: 'file_a', versionId: 'ver_a', storageKey: 'acme.com/alice/file_a/ver_a-passport-scan' },
      { fileId: 'file_b', versionId: 'ver_b', storageKey: 'acme.com/bob/file_b/ver_b-holiday' },
    ];

    it('thumbnail keys of different files never collide', async () => {
      const processor = createThumbnailProcessor();
      const image = await createTestImage(64, 64);
      const keys: string[] = [];
      for (const source of sources) {
        const result = await processor.process({ ...source, mimeType: 'image/png', size: image.length, fileName: 'x' }, async () => image);
        expect(result.success).toBe(true);
        for (const artifact of result.artifacts) {
          expect(artifact.storageKey.startsWith(`${source.storageKey}-thumb-`)).toBe(true);
          keys.push(artifact.storageKey);
        }
      }
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('image transform keys keep the full source prefix and drop only a real extension', async () => {
      const processor = createImageTransformProcessor({ operations: [{ operation: 'resize', options: { width: 8, height: 8 } }] });
      const image = await createTestImage(16, 16);
      const result = await processor.process(
        { fileId: 'file_a', versionId: 'ver_a', storageKey: 'acme.com/alice/file_a/ver_a-photo.png', mimeType: 'image/png', size: image.length, fileName: 'photo.png' },
        async () => image,
      );
      expect(result.success).toBe(true);
      for (const artifact of result.artifacts) {
        expect(artifact.storageKey.startsWith('acme.com/alice/file_a/ver_a-photo')).toBe(true);
      }
    });
  });

  describe('declared type is checked against the bytes (FILE-30 F-12)', () => {
    const input = { fileId: 'file_a', versionId: 'ver_a', storageKey: 't/a/file_a/ver_a-x', fileName: 'x' };

    it.each([
      ['an SVG', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'],
      ['a PDF', '%PDF-1.7\n1 0 obj'],
      ['HTML', '<html><body>hi</body></html>'],
    ])('refuses %s declared as image/png before any decoder sees it', async (_label, text) => {
      const bytes = new TextEncoder().encode(text);
      const result = await createThumbnailProcessor().process({ ...input, mimeType: 'image/png', size: bytes.length }, async () => bytes);
      expect(result.success).toBe(false);
      expect(result.error).toBe(CONTENT_TYPE_MISMATCH_ERROR);
    });

    it('accepts a PNG declared as image/jpeg (same family)', async () => {
      const image = await createTestImage(32, 32);
      const result = await createThumbnailProcessor().process({ ...input, mimeType: 'image/jpeg', size: image.length }, async () => image);
      expect(result.success).toBe(true);
    });

    it('classifies media and documents by family', () => {
      // Media is not sniffed: a playlist declared as video/mp4 is parsed only by the pinned mov demuxer.
      const playlist = new TextEncoder().encode('#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n');
      expect(contentMatchesDeclaredType(playlist, 'video/mp4')).toBe(true);
      expect(ffmpegInputArgs('video/mp4', playlist)).toEqual(['-protocol_whitelist', 'file', '-f', 'mov']);
      // A media type without a pinned demuxer is refused.
      expect(contentMatchesDeclaredType(playlist, 'application/x-mpegurl')).toBe(true);
      expect(contentMatchesDeclaredType(playlist, 'video/x-unknown')).toBe(false);
      expect(contentMatchesDeclaredType(playlist, 'audio/x-mpegurl')).toBe(false);
      expect(contentMatchesDeclaredType(new TextEncoder().encode('junk%PDF-1.4'), 'application/pdf')).toBe(true);
      expect(contentMatchesDeclaredType(new TextEncoder().encode('<svg/>'), 'application/pdf')).toBe(false);
      expect(contentMatchesDeclaredType(new TextEncoder().encode('anything'), 'text/plain')).toBe(true);
    });
  });

  describe('content signatures and demuxer pinning (FILE-30 F-12, round 2)', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const withHeader = (head: number[], rest = 32) => new Uint8Array([...head, ...new Array(rest).fill(0)]);

    it('accepts BigTIFF', () => {
      expect(contentMatchesDeclaredType(withHeader([0x49, 0x49, 0x2b, 0x00]), 'image/tiff')).toBe(true);
      expect(contentMatchesDeclaredType(withHeader([0x4d, 0x4d, 0x00, 0x2b]), 'image/tiff')).toBe(true);
    });

    it('pins LOAS AAC to the loas demuxer and ADTS to aac', () => {
      const loas = new Uint8Array([0x56, 0xe0, 0x20, 0, 0]);
      expect(ffmpegInputArgs('audio/aac', loas)).toEqual(['-protocol_whitelist', 'file', '-f', 'loas']);
      expect(ffmpegInputArgs('audio/aac', new Uint8Array([0xff, 0xf1, 0x50]))).toEqual(['-protocol_whitelist', 'file', '-f', 'aac']);
      expect(ffmpegInputArgs('audio/mpeg', loas)).toEqual(['-protocol_whitelist', 'file', '-f', 'mp3']);
      const id3 = new Uint8Array([...bytes('ID3'), 4, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
      expect(ffmpegInputArgs('audio/aac', new Uint8Array([...id3, ...loas]))).toEqual(['-protocol_whitelist', 'file', '-f', 'loas']);
    });

    it('thumbnails only raster bytes even for a MIME alias an integrator added', async () => {
      THUMBNAIL_SUPPORTED_MIME_TYPES.push('image/x-png');
      try {
        const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
        const result = await createThumbnailProcessor().process(
          { fileId: 'f', versionId: 'v', storageKey: 't/f/v-x.png', mimeType: 'image/x-png', size: svg.length, fileName: 'x.png' },
          async () => svg,
        );
        expect(result).toMatchObject({ success: false, error: CONTENT_TYPE_MISMATCH_ERROR });
      } finally {
        THUMBNAIL_SUPPORTED_MIME_TYPES.splice(THUMBNAIL_SUPPORTED_MIME_TYPES.indexOf('image/x-png'), 1);
      }
    });

    it('maps common media MIME aliases to the pinned demuxer', () => {
      expect(contentMatchesDeclaredType(bytes('anything'), 'audio/x-wav')).toBe(true);
      expect(ffmpegInputArgs('audio/x-wav')).toEqual(['-protocol_whitelist', 'file', '-f', 'wav']);
      expect(ffmpegInputArgs('audio/x-flac')).toEqual(['-protocol_whitelist', 'file', '-f', 'flac']);
      expect(ffmpegInputArgs('audio/x-aac', new Uint8Array([0x56, 0xe0, 0x20]))).toEqual(['-protocol_whitelist', 'file', '-f', 'loas']);
    });

    it('lets only raster images reach sharp in the tesseract.js provider, whatever the declared type', async () => {
      const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
      expect(() => assertRasterImage(svg)).toThrow(CONTENT_TYPE_MISMATCH_ERROR);
      expect(() => assertRasterImage(withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).not.toThrow();
      await expect(
        createTesseractJsOCRProvider().recognize({
          input: { fileId: 'f', versionId: 'v', storageKey: 'k.svg', mimeType: 'image/svg', size: svg.length, fileName: 'k.svg' },
          imageData: svg,
          language: 'eng',
          includeHOCR: false,
        }),
      ).rejects.toThrow(CONTENT_TYPE_MISMATCH_ERROR);
    });

    it('refuses two-letter BMP and non-image ftyp headers as images', () => {
      expect(contentMatchesDeclaredType(bytes('BM<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')).toBe(false);
      expect(contentMatchesDeclaredType(bytes('AAAAftypXXXX<svg/>'), 'image/png')).toBe(false);
      expect(contentMatchesDeclaredType(bytes('\0\0\0\x18ftypavif\0\0\0\0'), 'image/avif')).toBe(true);
    });

    it('renders a PDF preview only from %PDF on, so an SVG mentioning %PDF- gets the placeholder', async () => {
      const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!-- %PDF-1.7 --><rect width="10" height="10"/></svg>');
      expect(pdfStart(svg)).toBeGreaterThan(0);
      const result = await createPdfPreviewProcessor().process(
        { fileId: 'f', versionId: 'v', storageKey: 't/f/v-x', mimeType: 'application/pdf', size: svg.length, fileName: 'x.pdf' },
        async () => svg,
      );
      expect(result.success).toBe(true);
      for (const artifact of result.artifacts) {
        expect((artifact.metadata as Record<string, unknown> | undefined)?.renderMode).not.toBe('page-rasterized');
      }
    });

    it('pins ffmpeg to the declared demuxer with only the file protocol', () => {
      expect(ffmpegInputArgs('video/mp4')).toEqual(['-protocol_whitelist', 'file', '-f', 'mov']);
      expect(ffmpegInputArgs('audio/mpeg')).toEqual(['-protocol_whitelist', 'file', '-f', 'mp3']);
      expect(() => ffmpegInputArgs('application/x-mpegurl')).toThrow(CONTENT_TYPE_MISMATCH_ERROR);
    });
  });
});
