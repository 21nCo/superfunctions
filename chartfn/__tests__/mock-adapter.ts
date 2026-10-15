import { ChartAdapter, ChartAdapterHandle, ChartSpec } from "../src/types.js";

export class MockAdapter implements ChartAdapter {
  readonly name: string;
  public mounts: Array<{ container: HTMLElement; spec: ChartSpec }> = [];
  public shouldThrow = false;

  constructor(name = "mock") {
    this.name = name;
  }

  mount(container: HTMLElement, spec: ChartSpec): ChartAdapterHandle {
    if (this.shouldThrow) {
      throw new Error("Mock adapter failure");
    }
    this.mounts.push({ container, spec });
    return {
      update: () => undefined,
      dispose: () => undefined,
    };
  }
}
