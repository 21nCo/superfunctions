import { cleanup } from "@testing-library/svelte";
import { afterEach, vi } from "vitest";
import { installCanvasMocks } from "../../testing/canvas";

installCanvasMocks(true);
afterEach(() => { cleanup(); vi.clearAllMocks(); });
