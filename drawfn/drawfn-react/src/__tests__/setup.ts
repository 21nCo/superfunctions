import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { installCanvasMocks } from "../../../testing/canvas";

installCanvasMocks(true);
afterEach(() => { cleanup(); vi.clearAllMocks(); });
