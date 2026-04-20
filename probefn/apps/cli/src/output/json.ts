import type { JsonValue, ProbefnEnvelope } from '@probefn/contracts';

export async function writeJsonEnvelope(
  stream: NodeJS.WritableStream,
  envelope: ProbefnEnvelope<JsonValue>,
): Promise<void> {
  await writeToStream(stream, `${JSON.stringify(envelope, null, 2)}\n`);
}

function writeToStream(
  stream: NodeJS.WritableStream,
  value: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
