import { createHmac } from "node:crypto";

export function computeWebhookSignature(body: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body, "utf8");
  return `v1=${hmac.digest("hex")}`;
}
