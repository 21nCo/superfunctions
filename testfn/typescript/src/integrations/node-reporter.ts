/** Machine-readable Node test events used by Puppeteer suites written with node:test. */
export default async function* reporter(
  source: AsyncIterable<any>,
): AsyncGenerator<string> {
  for await (const event of source) {
    if (event.type === "test:stdout" || event.type === "test:stderr") {
      yield JSON.stringify({
        event: "log",
        stream: event.type.slice(5),
        message: event.data.message,
      }) + "\n";
      continue;
    }

    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (event.data.details?.type === "suite") continue;
    const data = event.data;
    yield JSON.stringify({
      name: data.name,
      status:
        data.skip || data.todo
          ? "skipped"
          : event.type === "test:pass"
            ? "passed"
            : "failed",
      duration: data.details?.duration_ms ?? 0,
      error: data.details?.error
        ? {
            message: data.details.error.message,
            stack: data.details.error.stack,
          }
        : undefined,
    }) + "\n";
  }
}
