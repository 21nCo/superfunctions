import { SyntheticCheck, CheckResult, Assertion } from "./types";

export class HttpCheckRunner {
  async run(check: SyntheticCheck): Promise<CheckResult> {
    const start = Date.now();
    try {
      if (!check.url) throw new Error("URL required for HTTP check");

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), check.timeout || 5000);

      const response = await fetch(check.url, {
        method: check.method || "GET",
        headers: check.headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const duration = Date.now() - start;
      const text = await response.text();

      // Validate assertions
      if (check.assertions) {
        for (const assertion of check.assertions) {
          this.validateAssertion(assertion, response, text, duration);
        }
      }

      return {
        checkId: check.id!,
        timestamp: Date.now(),
        success: true,
        duration,
        response: {
          status: response.status,
          headers: this.headersToObject(response.headers),
          bodySize: text.length,
        },
      };
    } catch (e: any) {
      return {
        checkId: check.id!,
        timestamp: Date.now(),
        success: false,
        duration: Date.now() - start,
        error: e.message || String(e),
      };
    }
  }

  private validateAssertion(assertion: Assertion, response: Response, body: string, duration: number) {
    let actualValue: any;

    switch (assertion.type) {
      case "status":
        actualValue = response.status;
        break;
      case "responseTime":
        actualValue = duration;
        break;
      case "body":
        actualValue = body;
        break;
      case "header":
        actualValue = response.headers.get(assertion.key || "");
        break;
    }

    let passed = false;
    switch (assertion.operator) {
      case "eq":
        passed = actualValue == assertion.value;
        break;
      case "lt":
        passed = actualValue < assertion.value;
        break;
      case "gt":
        passed = actualValue > assertion.value;
        break;
      case "contains":
        passed = String(actualValue).includes(assertion.value);
        break;
    }

    if (!passed) {
      throw new Error(`Assertion failed: ${assertion.type} ${assertion.operator} ${assertion.value} (got ${actualValue})`);
    }
  }

  private headersToObject(headers: Headers): Record<string, string> {
    const obj: Record<string, string> = {};
    headers.forEach((v, k) => (obj[k] = v));
    return obj;
  }
}
