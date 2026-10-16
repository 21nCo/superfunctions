import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export async function post(serverUrl: string, path: string, body: unknown): Promise<unknown> {
  const url = new URL(path, serverUrl);
  const payload = JSON.stringify(body);
  const mod = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("Invalid JSON response from server"));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export async function get(serverUrl: string, path: string): Promise<unknown> {
  const url = new URL(path, serverUrl);
  const mod = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("Invalid JSON response from server"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}
