import { logger } from "./logger.js";
import { resolveContainer } from "./resolve-container.js";
import { validateChartSpec } from "./validate.js";
import {
  ChartAdapter,
  ChartAdapterHandle,
  ChartFnAPI,
  ChartFnConfig,
  ChartSpec,
  ChartfnEnvelope,
  ChartfnError,
} from "./types.js";

const adapterUnknown = (adapter: string): ChartfnEnvelope<ChartAdapterHandle> => ({
  ok: false,
  error: {
    code: "ADAPTER_UNKNOWN",
    message: `Adapter not registered: ${adapter}`,
    details: { adapter },
  } satisfies ChartfnError,
});

const adapterError = (adapter: string, message = "Adapter failed during mount"): ChartfnEnvelope<ChartAdapterHandle> => ({
  ok: false,
  error: {
    code: "ADAPTER_ERROR",
    message,
    details: { adapter },
  } satisfies ChartfnError,
});

export const chartFn = (config: ChartFnConfig): ChartFnAPI => {
  const adapters = new Map<string, ChartAdapter>(
    Object.entries(config.adapters ?? {}),
  );
  let defaultAdapter = config.defaultAdapter;

  const registerAdapter = (name: string, adapter: ChartAdapter): void => {
    adapters.set(name, adapter);
    logger.debug("chartfn.registerAdapter", { adapter: name });
  };

  const use = (adapterName: string): ChartAdapter | undefined =>
    adapters.get(adapterName);

  const getDefaultAdapter = (): string => defaultAdapter;

  const setDefaultAdapter = (name: string): void => {
    defaultAdapter = name;
  };

  const render = (
    container: HTMLElement | string,
    spec: ChartSpec,
    options?: { adapter?: string },
  ): ChartfnEnvelope<ChartAdapterHandle> => {
    const resolvedContainer = resolveContainer(container);
    if (!resolvedContainer) {
      logger.error("chartfn.render.error", {
        code: "ADAPTER_ERROR",
        adapter: options?.adapter ?? defaultAdapter,
        path: "container",
      });
      return adapterError(
        options?.adapter ?? defaultAdapter,
        "Container not found",
      );
    }

    const validation = validateChartSpec(spec);
    if (!validation.ok) {
      logger.warn("chartfn.render.invalidSpec", {
        code: validation.error.code,
        path: validation.error.details.path,
      });
      return validation;
    }

    const adapterName = options?.adapter ?? defaultAdapter;
    const adapter = adapters.get(adapterName);
    if (!adapter) {
      logger.warn("chartfn.render.adapterUnknown", {
        code: "ADAPTER_UNKNOWN",
        adapter: adapterName,
        type: spec.type,
      });
      return adapterUnknown(adapterName);
    }

    try {
      logger.debug("chartfn.render.start", { adapter: adapterName, type: spec.type });
      const handle = adapter.mount(resolvedContainer, spec);
      let disposed = false;
      return { ok: true, result: {
        update(nextSpec) {
          if (disposed) return;
          const valid = validateChartSpec(nextSpec);
          if (!valid.ok) throw Object.assign(new Error(valid.error.message), valid.error);
          handle.update(nextSpec);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          handle.dispose();
        },
        ...(handle.toImage ? { toImage: (imageOptions: Parameters<NonNullable<ChartAdapterHandle['toImage']>>[0]) =>
          disposed ? Promise.resolve('') : handle.toImage!(imageOptions) } : {}),
      } };
    } catch {
      logger.error("chartfn.render.adapterError", {
        code: "ADAPTER_ERROR",
        adapter: adapterName,
      });
      return adapterError(adapterName);
    }
  };

  return {
    render,
    use,
    registerAdapter,
    getDefaultAdapter,
    setDefaultAdapter,
  } satisfies ChartFnAPI;
};
