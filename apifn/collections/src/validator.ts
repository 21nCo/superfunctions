import type { ValidationError } from "@apifn/core";
import type { Collection } from "./types.js";

export function validateCollection(collection: Collection): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!collection.info?.name || typeof collection.info.name !== "string") {
    errors.push({
      path: "info.name",
      message: "Collection info.name is required and must be a string",
      severity: "error",
    });
  }

  for (const [envName, env] of Object.entries(collection.environments)) {
    if (!env || typeof env !== "object") {
      errors.push({
        path: `environments.${envName}`,
        message: "Environment must be an object",
        severity: "error",
      });
      continue;
    }

    if (!env.variables || typeof env.variables !== "object") {
      errors.push({
        path: `environments.${envName}.variables`,
        message: "Environment variables are required",
        severity: "error",
      });
    }
  }

  function validateItems(items: Collection["items"], parentPath: string): void {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const itemPath = `${parentPath}[${index}]`;

      if (item.kind === "request") {
        const method = item.request?.http?.method;
        if (!method || typeof method !== "string") {
          errors.push({
            path: `${itemPath}.request.http.method`,
            message: "Request http.method is required",
            severity: "error",
          });
        }
      }

      if (item.kind === "folder" && item.children) {
        validateItems(item.children, `${itemPath}.children`);
      }
    }
  }

  validateItems(collection.items, "items");
  return errors;
}
