export type CheckType = "http" | "browser";

export interface Assertion {
  type: "status" | "responseTime" | "body" | "header";
  operator: "eq" | "lt" | "gt" | "contains";
  value: any;
  key?: string; // for header
}

export interface SyntheticCheck {
  id?: string;
  name: string;
  type: CheckType;
  url?: string; // for http
  method?: string;
  headers?: Record<string, string>;
  interval: number; // in ms
  timeout?: number;
  assertions?: Assertion[];
  // locations?: string[]; // Not supported in self-hosted single node for now
}

export interface CheckResult {
  checkId: string;
  timestamp: number;
  success: boolean;
  duration: number;
  error?: string;
  response?: {
    status?: number;
    headers?: Record<string, string>;
    bodySize?: number;
  };
}
