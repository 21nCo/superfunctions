import type { JsonValue, ProbefnEnvelope } from '@probefn/contracts';

export function formatHumanError(envelope: ProbefnEnvelope<JsonValue>): string {
  if (envelope.ok) {
    return '';
  }

  return `${envelope.error.code}: ${envelope.error.message}`;
}

export async function writeHumanOutput(
  stream: NodeJS.WritableStream,
  value: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(`${value}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
