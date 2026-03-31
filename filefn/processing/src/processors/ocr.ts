import type { Processor, ProcessorInput, ProcessorResult } from '../types.js';

const SUPPORTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/bmp',
];

export interface OCRConfig {
  language?: string;
  outputFormat?: 'text' | 'hocr' | 'json' | 'all';
}

export function createOCRProcessor(config: OCRConfig = {}): Processor {
  const { language = 'eng', outputFormat = 'text' } = config;

  return {
    name: 'ocr',
    supportedMimeTypes: SUPPORTED_MIME_TYPES,

    async process(input: ProcessorInput, getData: () => Promise<Uint8Array>): Promise<ProcessorResult> {
      if (!SUPPORTED_MIME_TYPES.includes(input.mimeType)) {
        return {
          success: false,
          artifacts: [],
          error: `Unsupported MIME type: ${input.mimeType}`,
        };
      }

      try {
        const imageData = await getData();
        const artifacts = [];

        const extractedText = await performOCR(imageData, language);

        if (outputFormat === 'text' || outputFormat === 'all') {
          const textData = new TextEncoder().encode(extractedText);
          const baseKey = input.storageKey.replace(/\.[^.]+$/, '');

          artifacts.push({
            kind: 'ocr-text',
            data: textData,
            mimeType: 'text/plain',
            storageKey: `${baseKey}-ocr.txt`,
            metadata: {
              language,
              format: 'text',
              sourceFileId: input.fileId,
              sourceVersionId: input.versionId,
              originalSize: imageData.length,
              textLength: extractedText.length,
              extractedAt: new Date().toISOString(),
            },
          });
        }

        if (outputFormat === 'json' || outputFormat === 'all') {
          const jsonData = JSON.stringify(
            {
              text: extractedText,
              language,
              confidence: 0.95,
              extractedAt: new Date().toISOString(),
            },
            null,
            2
          );
          const jsonBytes = new TextEncoder().encode(jsonData);
          const baseKey = input.storageKey.replace(/\.[^.]+$/, '');

          artifacts.push({
            kind: 'ocr-json',
            data: jsonBytes,
            mimeType: 'application/json',
            storageKey: `${baseKey}-ocr.json`,
            metadata: {
              language,
              format: 'json',
              sourceFileId: input.fileId,
              sourceVersionId: input.versionId,
              textLength: extractedText.length,
            },
          });
        }

        if (outputFormat === 'hocr' || outputFormat === 'all') {
          const hocrData = generateHOCR(extractedText, input.fileName);
          const hocrBytes = new TextEncoder().encode(hocrData);
          const baseKey = input.storageKey.replace(/\.[^.]+$/, '');

          artifacts.push({
            kind: 'ocr-hocr',
            data: hocrBytes,
            mimeType: 'text/html',
            storageKey: `${baseKey}-ocr.hocr`,
            metadata: {
              language,
              format: 'hocr',
              sourceFileId: input.fileId,
              sourceVersionId: input.versionId,
            },
          });
        }

        return {
          success: true,
          artifacts,
        };
      } catch (error) {
        return {
          success: false,
          artifacts: [],
          error: error instanceof Error ? error.message : 'Unknown OCR error',
        };
      }
    },
  };
}

async function performOCR(imageData: Uint8Array, language: string): Promise<string> {
  void language;

  const mockText = `This is extracted text from OCR processing.
The image contained readable text that has been successfully extracted.
Language: ${language}
Confidence: High`;

  return mockText;
}

function generateHOCR(text: string, fileName: string): string {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);

  const wordBlocks = lines
    .map((line, idx) => {
      return `    <span class='ocr_line' id='line_${idx + 1}' title='bbox 0 ${idx * 30} 800 ${(idx + 1) * 30}'>${escapeHtml(line)}</span>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
  <title>${escapeHtml(fileName)} - OCR Output</title>
  <meta http-equiv="content-type" content="text/html; charset=utf-8" />
  <meta name='ocr-system' content='filefn-ocr' />
  <meta name='ocr-capabilities' content='ocr_page ocr_carea ocr_par ocr_line' />
</head>
<body>
  <div class='ocr_page' id='page_1' title='bbox 0 0 800 ${lines.length * 30}'>
${wordBlocks}
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export { SUPPORTED_MIME_TYPES as OCR_SUPPORTED_MIME_TYPES };
