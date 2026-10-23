import React from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DrawfnCanvas } from "../DrawfnCanvas";
import type { UseDrawfnResult } from "../use-drawfn";

describe("DrawfnCanvas", () => {
  it("mounts a canvas and calls onReady once per instance", async () => {
    const onReady = vi.fn<(value: UseDrawfnResult) => void>();
    const { container, rerender } = render(
      <DrawfnCanvas width={640} height={480} onReady={onReady} />
    );

    expect(container.querySelector("canvas")).toBeTruthy();

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    const readyValue = onReady.mock.calls[0]?.[0];
    expect(readyValue?.isReady).toBe(true);
    expect(readyValue?.drawfn).toBeTruthy();

    rerender(<DrawfnCanvas width={640} height={480} onReady={onReady} />);

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });
  });
});
