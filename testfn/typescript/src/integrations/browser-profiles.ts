import type { BrowserConfig, DeviceProfile, NetworkProfile } from "../types.js";
export const networkProfiles: Record<
  "fast3g" | "slow3g" | "offline",
  NetworkProfile
> = {
  fast3g: {
    name: "fast3g",
    downloadThroughput: 1.6,
    uploadThroughput: 0.75,
    latency: 40,
  },
  slow3g: {
    name: "slow3g",
    downloadThroughput: 0.4,
    uploadThroughput: 0.4,
    latency: 400,
  },
  offline: {
    name: "offline",
    downloadThroughput: 0,
    uploadThroughput: 0,
    latency: 0,
  },
};
export function deviceBrowser(
  name: BrowserConfig["name"],
  device: DeviceProfile,
): BrowserConfig {
  return {
    name,
    userAgent: device.userAgent,
    viewport: device.viewport,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
  };
}
interface NetworkSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}
interface NetworkPage {
  context(): {
    setOffline(offline: boolean): Promise<void>;
    newCDPSession?: (page: any) => Promise<NetworkSession>;
  };
}
/** Mbps for throughput, milliseconds for latency. Returns an explicit cleanup function. */
export async function applyNetworkProfile(
  page: NetworkPage,
  profile: NetworkProfile,
): Promise<() => Promise<void>> {
  for (const value of [
    profile.downloadThroughput,
    profile.uploadThroughput,
    profile.latency,
  ])
    if (!Number.isFinite(value) || value < 0)
      throw new Error("Network profile values must be finite and nonnegative");
  const context = page.context();
  if (profile.name === "offline") {
    await context.setOffline(true);
    return () => context.setOffline(false);
  }
  if (!context.newCDPSession)
    throw new Error("Bandwidth and latency emulation require Chromium CDP");
  let session: NetworkSession;
  try {
    session = await context.newCDPSession(page);
  } catch {
    throw new Error("Bandwidth and latency emulation require Chromium CDP");
  }
  try {
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      downloadThroughput: (profile.downloadThroughput * 1000000) / 8,
      uploadThroughput: (profile.uploadThroughput * 1000000) / 8,
      latency: profile.latency,
    });
  } catch (error) {
    await session.detach();
    throw error;
  }
  return async () => {
    try {
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        downloadThroughput: -1,
        uploadThroughput: -1,
        latency: 0,
      });
    } finally {
      await session.detach();
    }
  };
}
