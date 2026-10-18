import { it, expect, vi } from "vitest";
import {
  applyNetworkProfile,
  deviceBrowser,
  networkProfiles,
} from "../src/integrations/browser-profiles.js";
it("converts Mbps to bytes, resets conditions and always detaches", async () => {
  const session = {
    send: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
  };
  const context = {
    setOffline: vi.fn(async () => {}),
    newCDPSession: async () => session,
  };
  const page = { context: () => context };
  const cleanup = await applyNetworkProfile(page, networkProfiles.fast3g);
  expect(session.send).toHaveBeenCalledWith(
    "Network.emulateNetworkConditions",
    {
      offline: false,
      downloadThroughput: 200000,
      uploadThroughput: 93750,
      latency: 40,
    },
  );
  await cleanup();
  expect(session.detach).toHaveBeenCalledOnce();
  const offline = await applyNetworkProfile(page, networkProfiles.offline);
  await offline();
  expect(context.setOffline.mock.calls).toEqual([[true], [false]]);
  session.send.mockRejectedValueOnce(Error("protocol failed"));
  await expect(
    applyNetworkProfile(page, networkProfiles.slow3g),
  ).rejects.toThrow("protocol failed");
  expect(session.detach).toHaveBeenCalledTimes(2);
  const noCdp = { context: () => ({ setOffline: async () => {} }) };
  await expect(
    applyNetworkProfile(noCdp, networkProfiles.fast3g),
  ).rejects.toThrow("require Chromium");
  await expect(
    applyNetworkProfile(
      {
        context: () => ({
          ...context,
          newCDPSession: async () => {
            throw Error("firefox");
          },
        }),
      },
      networkProfiles.fast3g,
    ),
  ).rejects.toThrow("require Chromium");
  await expect(
    applyNetworkProfile(page, { ...networkProfiles.fast3g, latency: -1 }),
  ).rejects.toThrow("nonnegative");
  expect(
    deviceBrowser("webkit", {
      name: "phone",
      userAgent: "phone",
      viewport: { width: 300, height: 600 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    }),
  ).toEqual({
    name: "webkit",
    userAgent: "phone",
    viewport: { width: 300, height: 600 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
});
