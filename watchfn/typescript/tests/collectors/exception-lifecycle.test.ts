import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { ExceptionHandler } from "../../src/collectors/errors/exception-handler";
import { WatchFn } from "../../src/core/watch-fn";

const handlers: ExceptionHandler[] = [];
const watches: WatchFn[] = [];
afterEach(async () => {
  for (const handler of handlers.splice(0)) handler.uninstall();
  for (const watch of watches.splice(0)) await watch.stop();
  vi.unstubAllGlobals();
});
function handler() {
  const captureException = vi.fn();
  const instance = new ExceptionHandler({ captureException });
  handlers.push(instance); return { instance, captureException };
}

it("installs once, removes only its own listener, and supports restart", () => {
  const baseline = process.listenerCount("uncaughtExceptionMonitor");
  const { instance: first } = handler(); const { instance: second } = handler();
  first.install(); first.install(); second.install();
  expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline + 2);
  first.uninstall(); first.uninstall();
  expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline + 1);
  first.install(); expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline + 2);
  first.uninstall(); second.uninstall(); expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline);
});

it("removes browser listeners, honors capture flags and does not prevent defaults", () => {
  const target = new EventTarget(); vi.stubGlobal("window", target);
  const { instance, captureException } = handler();
  const error = new Event("error", { cancelable: true }); Object.assign(error, { error: new Error("fatal"), message: "fatal" });
  const rejection = new Event("unhandledrejection", { cancelable: true }); Object.assign(rejection, { reason: new Error("rejected") });
  instance.install({ captureUnhandled: false, captureRejections: true });
  target.dispatchEvent(error); target.dispatchEvent(rejection);
  expect(captureException).toHaveBeenCalledTimes(1);
  expect(captureException.mock.calls[0][1].type).toBe("unhandledrejection");
  expect(rejection.defaultPrevented).toBe(false);
  instance.uninstall(); target.dispatchEvent(rejection); expect(captureException).toHaveBeenCalledTimes(1);
  instance.install({ captureUnhandled: true, captureRejections: false });
  target.dispatchEvent(error); target.dispatchEvent(rejection);
  expect(captureException).toHaveBeenCalledTimes(2); expect(error.defaultPrevented).toBe(false);
});

it("retains breadcrumbs, ignores configured errors and isolates capture failures", () => {
  const target = new EventTarget(); vi.stubGlobal("window", target);
  const { instance, captureException } = handler();
  instance.addBreadcrumb({ type: "user", message: "clicked" });
  const pattern = /ignored/g; pattern.lastIndex = 3;
  instance.install({ ignoreErrors: [pattern, "skip"] });
  const emit = (message: string) => {
    const event = new Event("error"); Object.assign(event, { error: new Error(message), message }); target.dispatchEvent(event);
  };
  emit("ignored"); emit("skip this"); expect(captureException).not.toHaveBeenCalled();
  expect(pattern.lastIndex).toBe(3);
  emit("captured"); expect(captureException.mock.calls[0][1].breadcrumbs[0].message).toBe("clicked");
  captureException.mockImplementation(() => { throw new Error("sink failure"); });
  expect(() => emit("captured again")).not.toThrow();
});

it("WatchFn stop/restart releases owned exception listeners", async () => {
  const baseline = process.listenerCount("uncaughtExceptionMonitor");
  const watch = new WatchFn({ name: "errors", errors: { enabled: true }, infra: { enabled: false } } as any); watches.push(watch);
  for (let i = 0; i < 3; i++) {
    watch.start(); watch.start(); expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline + 1);
    await watch.stop(); expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline);
  }
});

const bundled = buildSync({ entryPoints: [fileURLToPath(new URL("../../src/collectors/errors/exception-handler.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false }).outputFiles[0].text;

it.each([
  ["throw new Error('fatal-marker')", {}, true, "uncaughtException"],
  ["throw new Error('fatal-marker')", { captureUnhandled: false }, false, "uncaughtException"],
  ["Promise.reject(new Error('fatal-marker'))", {}, true, "unhandledRejection"],
  ["Promise.reject(new Error('fatal-marker'))", { captureRejections: false }, false, "unhandledRejection"],
])("preserves Node fatal behavior and capture flags: %s %j", (failure, options, captured, origin) => {
  const child = spawnSync(process.execPath, ["--unhandled-rejections=throw", "-e", `${bundled}
    const monitor = new module.exports.ExceptionHandler({captureException(error, context) { console.log('CAPTURED:' + context.origin); }});
    monitor.install(${JSON.stringify(options)});
    ${failure};
  `], { encoding: "utf8", timeout: 5000 });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
  expect(child.stderr).toContain("fatal-marker");
  expect(child.stdout.includes(`CAPTURED:${origin}`)).toBe(captured);
});

it("passes configured capture flags through the WatchFn lifecycle", async () => {
  const baseline = process.listenerCount("uncaughtExceptionMonitor");
  const watch = new WatchFn({ name: "errors", errors: { enabled: true, captureUnhandled: false, captureRejections: false },
    infra: { enabled: false } } as any); watches.push(watch);
  watch.start(); expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline);
  await watch.stop();
});

it("does not replace the fatal error when synchronous capture fails", () => {
  const child = spawnSync(process.execPath, ["-e", `${bundled}
    const monitor = new module.exports.ExceptionHandler({captureException() { throw new Error('sink-marker'); }});
    monitor.install(); throw new Error('original-marker');
  `], { encoding: "utf8", timeout: 5000 });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
  expect(child.stderr).toContain("original-marker");
  expect(child.stderr).not.toContain("Error: sink-marker");
});
