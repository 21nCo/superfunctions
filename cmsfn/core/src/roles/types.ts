/**
 * CmsFn role and permission model (SPEC.md).
 */

export type CmsfnAction =
  | "schema.read"
  | "doc.read"
  | "doc.create"
  | "doc.patch"
  | "doc.publish"
  | "doc.unpublish"
  | "doc.delete"
  | "asset.upload"
  | "asset.read"
  | "webhook.read"
  | "audit.read"
  | "release.manage";

export interface CmsfnRoleRule {
  datasets: string[] | "*";
  types: string[] | "*";
  actions: CmsfnAction[] | "*";
}

export interface CmsfnRole {
  id: string;
  name: string;
  rules: CmsfnRoleRule[];
}

export interface CmsfnPermissionInput {
  dataset: string;
  type: string;
  action: CmsfnAction;
}
