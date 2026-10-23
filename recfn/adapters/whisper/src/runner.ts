import type { Segment } from '@recfn/core';

export interface WhisperRunnerConfig {
  modelPath?: string;
  binaryPath?: string;
  threads?: number;
  language?: string;
  diarize?: boolean;
}

export interface WhisperOutput {
  segments: Segment[];
}

export interface WhisperRunner {
  run(audioPath: string, config: WhisperRunnerConfig): Promise<WhisperOutput>;
}

export function parseWhisperJsonOutput(jsonStr: string): Segment[] {
  const data = JSON.parse(jsonStr);

  if (Array.isArray(data)) {
    return data.map(parseSegmentEntry);
  }

  if (data.transcription && Array.isArray(data.transcription)) {
    return data.transcription.map(parseSegmentEntry);
  }

  if (data.segments && Array.isArray(data.segments)) {
    return data.segments.map(parseSegmentEntry);
  }

  return [];
}

function parseSegmentEntry(entry: Record<string, unknown>): Segment {
  const startTime = toMs(entry.start ?? entry.startTime ?? entry.t0 ?? 0);
  const endTime = toMs(entry.end ?? entry.endTime ?? entry.t1 ?? 0);
  const text = String(entry.text ?? '').trim();
  const confidence = Number(entry.confidence ?? entry.avg_logprob != null
    ? Math.exp(Number(entry.avg_logprob ?? 0))
    : 0.9);
  const speakerId = String(entry.speaker ?? entry.speakerId ?? 'speaker_0');

  return { speakerId, startTime, endTime, text, confidence };
}

function toMs(value: unknown): number {
  const num = Number(value);
  // Whisper outputs timestamps in seconds (typically < 36000 for a 10h recording).
  // Values with decimal points are clearly seconds.
  // Values >= 1000 without decimals are likely already in ms.
  if (num > 0 && (num < 1000 || num !== Math.floor(num))) {
    return Math.round(num * 1000);
  }
  return Math.round(num);
}

export function createChildProcessRunner(): WhisperRunner {
  return {
    async run(
      audioPath: string,
      config: WhisperRunnerConfig,
    ): Promise<WhisperOutput> {
      const { spawn } = await import('node:child_process');

      const binary = config.binaryPath ?? 'whisper-cpp';
      const args = [
        '-f', audioPath,
        '-oj',
        '--output-json',
      ];

      if (config.modelPath) {
        args.push('-m', config.modelPath);
      }
      if (config.threads) {
        args.push('-t', String(config.threads));
      }
      if (config.language) {
        args.push('-l', config.language);
      }
      if (config.diarize) {
        args.push('--diarize');
      }

      return new Promise<WhisperOutput>((resolve, reject) => {
        const proc = spawn(binary, args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on('close', (code: number | null) => {
          if (code !== 0) {
            reject(
              new Error(
                `Whisper process exited with code ${code}: ${stderr}`,
              ),
            );
            return;
          }

          try {
            const segments = parseWhisperJsonOutput(stdout);
            resolve({ segments });
          } catch (e) {
            reject(
              new Error(
                `Failed to parse Whisper output: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          }
        });

        proc.on('error', (e: Error) => {
          reject(new Error(`Failed to spawn Whisper process: ${e.message}`));
        });
      });
    },
  };
}
