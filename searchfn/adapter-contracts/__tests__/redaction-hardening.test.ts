import { describe, expect, it } from "vitest";
import { redactSensitive, redactSensitiveString } from "../src/index";

// Sensitive key words and URL userinfo are built at runtime so fixture strings
// are not mistaken for committed credentials.
const PW = ["pass", "word"].join("");
const userinfo = (secret: string) => ["user", secret].join(":");
const REDACTED_MARK = "[REDACTED]";

// Generous per-test timeout for the scaling checks below.
const SCALING_TIMEOUT = 60_000;

/**
 * Runs fn at size large / 4 and at large (best of three runs each, after a
 * warm-up) and fails on super-linear growth: linear work grows about 4x,
 * quadratic about 16x, so the limit of 10x leaves room for garbage-collection
 * and CPU-load noise. A small run under 50 ms counts as 50 ms, so timer noise
 * cannot fail a fast run, and the large run has an absolute bound with ample
 * headroom. This detects growth, not machine speed.
 */
function expectLinearScaling(large: number, fn: (n: number) => void): void {
  const small = Math.floor(large / 4);
  fn(Math.floor(small / 4));
  const time = (size: number) => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      fn(size);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  const smallTime = time(small);
  const largeTime = time(large);
  expect(largeTime).toBeLessThan(10 * Math.max(smallTime, 50));
  expect(largeTime).toBeLessThan(5_000);
}

describe("auth scheme words as secret values", () => {
  it("redacts a lone scheme word held by a non-authorization key, failing closed to the end of the line", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic connectionTimeout=5000`, `${PW}=[REDACTED]`],
      ["token=bearer connectionTimeout=5000", "token=[REDACTED]"],
      ["api_key=token connectionTimeout=5000", "api_key=[REDACTED]"],
      ["accessToken: Bearer test-token", "accessToken: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("keeps the scheme after an authorization key and redacts its credential", () => {
    const cases: Array<[string, string]> = [
      ["Authorization: Bearer test-token", "Authorization: Bearer [REDACTED]"],
      ["Proxy-Authorization: Basic test-credential", "Proxy-Authorization: Basic [REDACTED]"],
      ["authorization=token test-token next", "authorization=token [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });
});

describe("query containers", () => {
  it("redacts URLSearchParams values by decoded key, including bracketed keys", () => {
    const params = new URLSearchParams([
      [`user[${PW}]`, "test-password"],
      ["filter[token]", "test-token"],
      ["q", "red shoes"],
      ["page", "2"],
    ]);
    const redacted = redactSensitive(params);
    expect(redacted).toBe(`user%5B${PW}%5D=[REDACTED]&filter%5Btoken%5D=[REDACTED]&q=red+shoes&page=2`);
    expect(redacted).not.toMatch(/test-password|test-token/);
  });

  it("redacts percent-encoded keys in URL query strings and fragments", () => {
    const url = new URL(
      `https://example.test/search?user%5Btoken%5D=test-token&pass%77ord=test-password&q=x#access_token=test-fragment&state=ok`,
    );
    const redacted = redactSensitive({ endpoint: url }).endpoint;
    expect(redacted).toBe(
      // As at the pin, an unquoted sensitive value runs across & and #.
      "https://example.test/search?user%5Btoken%5D=[REDACTED]",
    );
    const separate = new URL("https://example.test/search?q=x&pass%77ord=test-password#state=ok&access_token=test-fragment");
    expect(redactSensitive(separate)).toBe(
      "https://example.test/search?q=x&pass%77ord=[REDACTED]#state=ok&access_token=[REDACTED]",
    );
    expect(redacted).not.toMatch(/test-token|test-password|test-fragment/);
  });

  it("redacts URL userinfo and sensitive params together while keeping the rest readable", () => {
    const url = new URL(`postgres://${userinfo("test-password")}@db.example.test:5432/app?sslmode=require&passwd=test-passwd`);
    const redacted = redactSensitive(url);
    expect(redacted).toBe("postgres://[REDACTED]@db.example.test:5432/app?sslmode=require&passwd=[REDACTED]");
  });

  it("still redacts key=value secrets inside non-sensitive parameter values", () => {
    const params = new URLSearchParams([["note", "token=test-token"]]);
    expect(redactSensitive(params)).toBe("note=token%3D[REDACTED]");
  });
});

describe("keys that still hold percent escapes after parsing", () => {
  it("redacts URLSearchParams and URL keys whose decoded form is sensitive", () => {
    // user[password] with the w escaped, built at runtime for the secret scan.
    const escapedKey = ["user%5B", "pass%77ord", "%5D"].join("");
    const params = new URLSearchParams([
      [escapedKey, "test-leak"],
      ["q", "x"],
    ]);
    const fromParams = redactSensitive(params);
    expect(fromParams).toBe("user%255Bpass%2577ord%255D=[REDACTED]&q=x");
    expect(fromParams).not.toContain("test-leak");

    const url = new URL("https://example.test/search?q=x");
    url.searchParams.set(escapedKey, "test-leak");
    const fromUrl = redactSensitive(url);
    expect(fromUrl).toBe("https://example.test/search?q=x&user%255Bpass%2577ord%255D=[REDACTED]");
    expect(fromUrl).not.toContain("test-leak");
  });

  it("keeps non-sensitive keys and malformed escapes readable", () => {
    const params = new URLSearchParams([
      ["filter%5Bcolor%5D", "red"],
      ["bad%E0%A4%A", "ok"],
    ]);
    expect(redactSensitive(params)).toBe("filter%255Bcolor%255D=red&bad%25E0%25A4%25A=ok");
  });
});

describe("bracketed keys in plain strings", () => {
  it("redacts values after ] or %5D closers and keeps quotes", () => {
    const cases: Array<[string, string]> = [
      [`GET /_search?user%5B${PW}%5D=test-leak`, `GET /_search?user%5B${PW}%5D=[REDACTED]`],
      [`GET /_search?user%5b${PW}%5d=test-leak&q=x`, `GET /_search?user%5b${PW}%5d=[REDACTED]`],
      [`user[${PW}]=test-leak`, `user[${PW}]=[REDACTED]`],
      [`{"user[${PW}]":"test-leak","q":"x"}`, `{"user[${PW}]":"[REDACTED]","q":"x"}`],
      ["headers[authorization]=Bearer test-leak", "headers[authorization]=Bearer [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });
});

describe("auth scheme on its own line", () => {
  it("does not carry the scheme match across a line break", () => {
    expect(redactSensitiveString("Authorization: Bearer\nstatus=401")).toBe("Authorization: [REDACTED]\nstatus=401");
    expect(redactSensitiveString("Authorization: Bearer\r\nstatus=401")).toBe("Authorization: [REDACTED]\r\nstatus=401");
    expect(redactSensitiveString("Authorization:\tBasic\ttest-leak\nstatus=401")).toBe(
      "Authorization:\tBasic\t[REDACTED]\nstatus=401",
    );
    expect(redactSensitiveString("Authorization: Bearer test-leak")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactSensitiveString(`${PW}=basic connectionTimeout=5000`)).toBe(`${PW}=[REDACTED]`);
  });
});

describe("escaped keys with malformed escapes", () => {
  // user[password] with the w escaped and a malformed tail, built at runtime.
  const tails = ["%ZZ", "%", "%E0%A4"];
  const escapedKeys = tails.map((tail) => ["user%5B", "pass%77ord", "%5D", tail].join(""));

  it("masks the value in URLSearchParams, URL query, URL fragment and object keys", () => {
    for (const key of escapedKeys) {
      expect(redactSensitive(new URLSearchParams([[key, "test-leak"]]))).not.toContain("test-leak");

      const url = new URL("https://example.test/search?q=x");
      url.searchParams.set(key, "test-leak");
      const fromQuery = redactSensitive(url);
      expect(fromQuery).toContain("=[REDACTED]");
      expect(fromQuery).not.toContain("test-leak");

      const withFragment = new URL("https://example.test/search");
      withFragment.hash = new URLSearchParams([[key, "test-leak"], ["state", "ok"]]).toString();
      const fromFragment = redactSensitive(withFragment);
      expect(fromFragment).toContain("&state=ok");
      expect(fromFragment).not.toContain("test-leak");

      expect(redactSensitive({ [key]: "test-leak" })).toEqual({ [key]: "[REDACTED]" });
    }
  });

  it("keeps non-sensitive keys with malformed escapes readable", () => {
    const params = new URLSearchParams([
      ["filter%5Bcolor%5D%ZZ", "red"],
      ["page%", "2"],
      ["sort%E0%A4", "asc"],
    ]);
    expect(redactSensitive(params)).toBe("filter%255Bcolor%255D%25ZZ=red&page%25=2&sort%25E0%25A4=asc");
    expect(redactSensitive({ "page%ZZ": "2" })).toEqual({ "page%ZZ": "2" });
  });
});

describe("credentials after an authorization key", () => {
  it("prints at most the key, separator and one recognised scheme label", () => {
    const cases: Array<[string, string]> = [
      ["Authorization: ApiKey test-api-key", "Authorization: [REDACTED]"],
      ["authorization: ApiKey test-api-key", "authorization: [REDACTED]"],
      ["Authorization: Negotiate test-ticket", "Authorization: [REDACTED]"],
      [
        'Authorization: Digest username="test-user", realm="test", nonce="test-nonce", response="test-response"',
        "Authorization: [REDACTED]",
      ],
      [
        "Authorization: AWS4-HMAC-SHA256 Credential=test-credential/scope, SignedHeaders=host, Signature=test-signature",
        "Authorization: [REDACTED]",
      ],
      ["Authorization: Bearer\ttest-token", "Authorization: Bearer\t[REDACTED]"],
      ["Authorization: Bearer  test-token", "Authorization: Bearer  [REDACTED]"],
      ["Authorization: Bearer test-token, extra-test-part", "Authorization: Bearer [REDACTED]"],
      ["Authorization: Bearer , test-token", "Authorization: [REDACTED]"],
      ["Proxy-Authorization: Digest test-response, nc=1", "Proxy-Authorization: [REDACTED]"],
      ["headers[authorization]=ApiKey test-api-key", "headers[authorization]=[REDACTED]"],
      ["Authorization: Bearer ***", "Authorization: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("keeps quoted and JSON values as before and leaves the next line readable", () => {
    expect(redactSensitiveString('{"authorization":"ApiKey test-api-key","q":"x"}')).toBe(
      '{"authorization":"[REDACTED]","q":"x"}',
    );
    expect(redactSensitiveString("Authorization: 'Digest test-response' status=401")).toBe(
      "Authorization: '[REDACTED]' status=401",
    );
    expect(redactSensitiveString("Authorization: ApiKey test-api-key, x=1\nstatus=401 q=x")).toBe(
      "Authorization: [REDACTED]\nstatus=401 q=x",
    );
    expect(redactSensitiveString("Authorization: Negotiate test-ticket\r\ntoken=test-token")).toBe(
      "Authorization: [REDACTED]\r\ntoken=[REDACTED]",
    );
  });
});

describe("scheme label without a credential after it", () => {
  it("redacts the label when the next same-line token is a name=value assignment", () => {
    // Base64 credential with trailing padding, built at runtime.
    const padded = btoa("test");
    const cases: Array<[string, string]> = [
      ["authorization=token connectionTimeout=5000", "authorization=[REDACTED]"],
      ["Authorization: Bearer x=1", "Authorization: [REDACTED]"],
      ["Authorization: Bearer status=401 requestId=test-request", "Authorization: [REDACTED]"],
      ["Authorization: Token token=test-token", "Authorization: [REDACTED]"],
      [`Authorization: Basic ${padded}`, "Authorization: Basic [REDACTED]"],
      [`Authorization: Basic ${padded} status=401`, "Authorization: Basic [REDACTED]"],
      ["Authorization: Bearer test-token\nstatus=401", "Authorization: Bearer [REDACTED]\nstatus=401"],
    ];
    expect(padded.endsWith("=")).toBe(true);
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("prints nothing after the key for AWS4 parameters", () => {
    const redacted = redactSensitiveString(
      "Authorization: AWS4-HMAC-SHA256 Credential=test-credential/scope,SignedHeaders=host,Signature=test-signature",
    );
    expect(redacted).toBe("Authorization: [REDACTED]");
  });
});

describe("URL fragments", () => {
  it("keeps non-sensitive fragment routes as written", () => {
    for (const href of [
      "https://example.test/#/callback?state=ok",
      "https://example.test/#?q=x&state=ok",
      "https://example.test/app#section-2",
      "https://example.test/#/a/b?x=1&y=2",
    ]) {
      expect(redactSensitive(new URL(href))).toBe(href);
    }
  });

  it("masks only the value of a sensitive segment in a fragment route", () => {
    const tokenKey = ["access", "token"].join("_");
    const url = new URL(`https://example.test/#/cb?state=ok&${tokenKey}=test-leak&next=/home`);
    // As at the pin, the unquoted value runs across the following parameters.
    expect(redactSensitive(url)).toBe(`https://example.test/#/cb?state=ok&${tokenKey}=[REDACTED]`);
  });
});

describe("round-7 fragment and scheme repairs", () => {
  it("drops the scheme label when the next token is not a credential token", () => {
    expect(redactSensitiveString("Authorization: Bearer status:401")).toBe("Authorization: [REDACTED]");
    expect(redactSensitiveString("Authorization: Bearer test-token")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactSensitiveString(`Authorization: Basic ${btoa("test")}`)).toBe("Authorization: Basic [REDACTED]");
  });

  it("redacts secrets that span fragment parameters or route text, as the pin does", () => {
    const authorizationKey = ["author", "ization"].join("");
    expect(redactSensitive(new URL(`https://example.test/#${authorizationKey}:test-token=`))).toBe(
      `https://example.test/#${authorizationKey}:[REDACTED]`,
    );
    const url = new URL(`https://example.test/#https://${userinfo("test-pass=")}@example.test/path`);
    expect(redactSensitive(url)).toBe("https://example.test/#https://[REDACTED]@example.test/path");
  });

  it("keeps empty query and fragment delimiters", () => {
    for (const href of [
      "https://example.test/#",
      "https://example.test/?",
      "https://example.test/?#",
      "https://example.test/path?q=1#",
    ]) {
      expect(redactSensitive(new URL(href))).toBe(href);
    }
  });

  it("redacts long fragments in linear time", () => {
    expectLinearScaling(48_000, (n) => {
      const routes = new URL(`https://example.test/#/${"x".repeat(n)}`);
      const params = new URL(`https://example.test/#/cb?${"q=1&".repeat(n / 4)}state=ok`);
      expect(redactSensitive(routes)).toBe(routes.href);
      expect(redactSensitive(params)).toBe(params.href);
    });
  }, SCALING_TIMEOUT);
});

describe("round-8 URL component and scheme-word repairs", () => {
  it("masks userinfo in a fragment before splitting it into parameters", () => {
    // Userinfo whose password holds a sensitive word and an =, built at runtime.
    const secret = ["my", "token", "9=abc"].join("");
    const https = new URL(`https://example.test/#https://${["svc", secret].join(":")}@db.example.test/`);
    expect(redactSensitive(https)).toBe("https://example.test/#https://[REDACTED]@db.example.test/");
    const postgres = new URL(`https://example.test/#postgres://${["svc", secret].join(":")}@db.example.test/app`);
    expect(redactSensitive(postgres)).toBe("https://example.test/#postgres://[REDACTED]@db.example.test/app");
    const query = new URL(`https://example.test/?next=https://${["svc", secret].join(":")}@db.example.test/&q=x`);
    expect(redactSensitive(query)).toBe("https://example.test/?next=https://[REDACTED]@db.example.test/&q=x");
  });

  it("keeps the raw query text and masks only sensitive values", () => {
    for (const href of ["https://example.test/?flag&&x=%20#", "https://example.test/?a=1&&b=%2B+c#/r?x=1&&y"]) {
      expect(redactSensitive(new URL(href))).toBe(href);
    }
    const escapedKey = ["user%5B", PW, "%5D"].join("");
    expect(redactSensitive(new URL(`https://example.test/?${escapedKey}=test-leak&flag`))).toBe(
      `https://example.test/?${escapedKey}=[REDACTED]`,
    );
    expect(redactSensitive(new URL(`https://example.test/?flag&pass%77ord=test-leak`))).toBe(
      "https://example.test/?flag&pass%77ord=[REDACTED]",
    );
  });

  it("still redacts encoded key=value secrets inside non-sensitive URL parameter values", () => {
    const url = new URL("https://example.test/search");
    url.searchParams.set("note", "token=test-token");
    expect(String(url)).toContain("note=token%3Dtest-token");
    expect(redactSensitive(url)).toBe("https://example.test/search?note=[REDACTED]");
    expect(redactSensitive(new URL("https://example.test/?note=token=test-token&q=x"))).toBe(
      "https://example.test/?note=token=[REDACTED]",
    );
  });

  it("redacts repeated token parameters in queries and fragments in linear time", () => {
    expectLinearScaling(16_000, (n) => {
      const fragmentAssign = new URL(`https://example.test/#${"token=x&".repeat(n)}`);
      const fragmentColon = new URL(`https://example.test/#${"token:x&".repeat(n)}`);
      const queryAssign = new URL(`https://example.test/?${"token=x&".repeat(n)}`);
      expect(redactSensitive(fragmentAssign)).toBe("https://example.test/#token=[REDACTED]");
      expect(redactSensitive(fragmentColon)).toBe("https://example.test/#token:[REDACTED]");
      expect(redactSensitive(queryAssign)).toBe("https://example.test/?token=[REDACTED]");
    });
  }, SCALING_TIMEOUT);

  it("masks a non-authorization value after a standing-alone scheme word to the end of the line", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic token: test-hidden`, `${PW}=[REDACTED]`],
      [`${PW}=basic connectionTimeout=5000`, `${PW}=[REDACTED]`],
      [`${PW}=token token=test-hidden q=x`, `${PW}=[REDACTED]`],
      ["accessToken: Basic test-user:test-pass", "accessToken: [REDACTED]"],
      [`accessToken: Basic ${btoa("test")} q=x`, "accessToken: [REDACTED] q=x"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
    // Authorization keys are unchanged: masked to the end of the line.
    expect(redactSensitiveString("authorization=basic token: test-hidden")).toBe("authorization=[REDACTED]");
  });
});

describe("round-9 scheme word before a key the redactor's own grammar recognises", () => {
  const tokenKey = ["to", "ken"].join("");
  const hidden = ["test", "hidden"].join("-");

  it("masks a non-authorization value to the end of the line when a key/value starts after the scheme word", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic ${tokenKey}= ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${tokenKey} = ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${tokenKey}: ${hidden}`, `${PW}=[REDACTED]`],
      [`${PW}=basic connectionTimeout=5000`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${btoa("test")} next`, `${PW}=[REDACTED] next`],
      ["accessToken: Bearer test-token", "accessToken: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("drops the authorization scheme label when a key/value starts at the next token", () => {
    const tok = ["test", "tok"].join("-");
    const cases: Array<[string, string]> = [
      [`Authorization: bearer ${tokenKey}= ${tok} status=401`, "Authorization: [REDACTED]"],
      [`Authorization: bearer ${tokenKey} = ${tok}`, "Authorization: [REDACTED]"],
      [`Authorization: Basic ${btoa("test")}`, "Authorization: Basic [REDACTED]"],
      ["Authorization: Bearer test-token\nnext=line", "Authorization: Bearer [REDACTED]\nnext=line"],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      expect(output).not.toContain(tok);
    }
  });
});

describe("round-10 scheme words and URL parameter boundaries", () => {
  const tokenKey = ["to", "ken"].join("");
  const hidden = ["test", "hidden"].join("-");

  it("masks a quoted, spaced or other assignment after a scheme word to the end of the line", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic db.${PW} = ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic "${tokenKey}" = ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic '${tokenKey}'= ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic status = 401`, `${PW}=[REDACTED]`],
      ["Authorization: bearer status = 401", "Authorization: [REDACTED]"],
      [`Authorization: bearer db.${PW} = x`, "Authorization: [REDACTED]"],
      // Round-9 cases still hold.
      ["Authorization: Bearer test-token", "Authorization: Bearer [REDACTED]"],
      [`Authorization: Basic ${btoa("test")}`, "Authorization: Basic [REDACTED]"],
      [`${PW}=basic ${btoa("test")} next`, `${PW}=[REDACTED] next`],
      ["accessToken: Bearer test-token", "accessToken: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      expect(output).not.toContain(hidden);
    }
  });

  it("decides scheme words in linear time", () => {
    expectLinearScaling(64_000, (n) => {
      expect(redactSensitiveString(`${PW}=basic x.`.repeat(n))).not.toContain("basic");
      expect(redactSensitiveString(`${PW}=basic "${"a".repeat(3 * n)}`)).toBe(`${PW}=[REDACTED]`);
      expect(redactSensitiveString(`authorization: bearer "${"a".repeat(3 * n)}`)).toBe("authorization: [REDACTED]");
    });
  }, SCALING_TIMEOUT);

  it("never prints a sensitive value tail after an @", () => {
    const value = ["sec", "ret"].join("@");
    for (const delimiter of ["?", "#"]) {
      const url = new URL(`https://example.test/${delimiter}next=https://a.test&${tokenKey}=${value}&q=1`);
      const redacted = redactSensitive(url);
      // Userinfo that holds a secret is masked with the run after its @.
      expect(redacted).toBe(`https://example.test/${delimiter}next=https://[REDACTED]&q=1`);
      expect(redacted).not.toContain("ret");
    }
    // Pin behaviour (deferred minor): userinfo matching crosses & and over-masks.
    const email = "https://example.test/?next=https://api.example.test&email=a@b.test";
    expect(redactSensitive(new URL(email))).toBe("https://example.test/?next=https://[REDACTED]@b.test");
  });

  it("masks a colon-delimited fragment credential as the pin does", () => {
    const authorizationKey = ["author", "ization"].join("");
    const cases: Array<[string, string]> = [
      [`#${authorizationKey}:test-part1&test-part2`, `#${authorizationKey}:[REDACTED]`],
      [`#${tokenKey}:abc&def`, `#${tokenKey}:[REDACTED]`],
      [`#${tokenKey}:x&state=ok`, `#${tokenKey}:[REDACTED]`],
      [`#${tokenKey}:x&${tokenKey}:y&z`, `#${tokenKey}:[REDACTED]`],
      [`#${tokenKey}:abc&&def&`, `#${tokenKey}:[REDACTED]`],
    ];
    for (const [fragment, expected] of cases) {
      expect(redactSensitive(new URL(`https://example.test/${fragment}`))).toBe(`https://example.test/${expected}`);
    }
  });
});

describe("round-11 whole-href string pass with an additive parameter post-pass", () => {
  const tokenKey = ["to", "ken"].join("");
  const authorizationKey = ["author", "ization"].join("");
  const href = (rest: string) => redactSensitive(new URL(`https://example.test/${rest}`));

  it("masks a quoted value that spans & as the pin does", () => {
    expect(href(`#${tokenKey}:'test-first&chunk=test-last'&state=ok`)).toBe(
      `https://example.test/#${tokenKey}:'[REDACTED]'&state=ok`,
    );
    expect(href(`#${tokenKey}='test-first&chunk=test-last'`)).toBe(`https://example.test/#${tokenKey}='[REDACTED]'`);
    expect(href(`#${tokenKey}:part1&=part2`)).not.toContain("part2");
  });

  it("never copies a secret held by an escaped key into the output", () => {
    for (const rest of [
      `?${authorizationKey}%3Atest-tok=1`,
      `#${authorizationKey}%3Atest-tok`,
      `?${tokenKey}%3Dtest-sec=1`,
      `?q=1&${authorizationKey}%253Atest-tok=1`,
    ]) {
      const redacted = href(rest);
      expect(redacted).not.toMatch(/test-tok|test-sec/);
      expect(redacted).toContain(REDACTED_MARK);
    }
    expect(href(`?q=1&${authorizationKey}%3Atest-tok=1&r=2`)).toBe("https://example.test/?q=1&[REDACTED]&r=2");
    const params = new URLSearchParams([
      [`${authorizationKey}%3Atest-tok`, "1"],
      ["q", "x"],
    ]);
    expect(redactSensitive(params)).toBe("[REDACTED]&q=x");
  });

  it("masks userinfo that holds & before any parameter split", () => {
    const secret = ["test-a", "test-b"].join("&");
    expect(href(`#https://${userinfo(secret)}@api.example.test/path`)).toBe(
      "https://example.test/#https://[REDACTED]@api.example.test/path",
    );
    expect(href(`#postgres://${userinfo(secret)}@db.example.test/app`)).toBe(
      "https://example.test/#postgres://[REDACTED]@db.example.test/app",
    );
  });

  it("masks a value whose decoded form holds a secret after a raw match", () => {
    const redacted = href(`?note=${tokenKey}=a,${tokenKey}%3Dsecond`);
    expect(redacted).toBe("https://example.test/?note=[REDACTED]");
    expect(redacted).not.toContain("second");
    const params = new URLSearchParams([["note", `${tokenKey}%3Dsecond`]]);
    expect(redactSensitive(params)).toBe("note=[REDACTED]");
  });

  it("keeps delimiters, routes and non-sensitive parameters as written", () => {
    for (const rest of ["?flag&&x=%20#", "#", "?", "#/callback?state=ok", "#section-2", "?a=1&&b=%2B+c#/r?x=1&&y"]) {
      expect(href(rest)).toBe(`https://example.test/${rest}`);
    }
    expect(href(`?pass%77ord=test-leak`)).toBe("https://example.test/?pass%77ord=[REDACTED]");
    expect(href(`?user%5B${PW}%5D=test-leak`)).toBe(`https://example.test/?user%5B${PW}%5D=[REDACTED]`);
    for (const scheme of ["https", "postgres", "redis", "ftp"]) {
      const redacted = redactSensitive(new URL(`${scheme}://${userinfo("test-pass")}@db.example.test/app?q=1#top`));
      expect(redacted).toBe(`${scheme}://[REDACTED]@db.example.test/app?q=1#top`);
    }
  });

  it("stays linear on long components", () => {
    expectLinearScaling(32_000, (n) => {
      const long = "a=b&".repeat(n);
      expect(href(`?${long}#${long}`)).toBe(`https://example.test/?${long}#${long}`);
      expect(href(`#${"x".repeat(4 * n)}`)).toBe(`https://example.test/#${"x".repeat(4 * n)}`);
      expect(href(`?${`${tokenKey}%3Dx&`.repeat(n / 2)}`)).toBe(`https://example.test/?${"[REDACTED]&".repeat(n / 2)}`);
    });
  }, SCALING_TIMEOUT);
});

describe("round-12 scheme word before an empty sensitive field", () => {
  const tokenKey = ["to", "ken"].join("");
  const secretKey = ["sec", "ret"].join("");

  it("never prints the scheme word when a sensitive key with no value follows it", () => {
    const cases: Array<[string, string]> = [
      [`Authorization: bearer ${tokenKey}=`, "Authorization: [REDACTED]"],
      [`Authorization: basic ${PW}=, status=401`, "Authorization: [REDACTED]"],
      [`Authorization: token ${secretKey}=;`, "Authorization: [REDACTED]"],
      [`Authorization: bearer db.${PW}=`, "Authorization: [REDACTED]"],
      [`Authorization: Basic ${tokenKey}=`, "Authorization: [REDACTED]"],
      [`${PW}=basic ${tokenKey}=`, `${PW}=[REDACTED]`],
      // Earlier cases still hold.
      ["Authorization: Bearer test-token", "Authorization: Bearer [REDACTED]"],
      [`Authorization: Basic ${btoa("test")}`, "Authorization: Basic [REDACTED]"],
      [`${PW}=basic ${btoa("test")} next`, `${PW}=[REDACTED] next`],
      [`${PW}=basic connectionTimeout=5000`, `${PW}=[REDACTED]`],
      ["accessToken: Bearer test-token", "accessToken: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
    expect(redactSensitiveString(`${PW}=basic ${tokenKey}=`)).not.toContain("basic");
  });

  it("decides scheme words before empty fields in linear time", () => {
    expectLinearScaling(64_000, (n) => {
      expect(redactSensitiveString("authorization: bearer x ".repeat(n))).toBe("authorization: bearer [REDACTED]");
      expect(redactSensitiveString(`${PW}=basic tok.`.repeat(n))).not.toContain("basic");
      expect(redactSensitiveString(`${PW}=basic ${tokenKey}= `.repeat(n))).not.toContain("basic");
    });
  }, SCALING_TIMEOUT);
});

describe("round-13 scheme word under a non-authorization key", () => {
  const tokenKey = ["to", "ken"].join("");
  const accessKey = ["access", "Token"].join("");
  const hidden = ["test", "hidden"].join("-");
  const sig = ["test", "sig"].join("-");

  it("never prints a credential holding = or : after a scheme word", () => {
    const cases: Array<[string, string]> = [
      [`${accessKey}: Bearer sv=1&sig=${sig}`, `${accessKey}: [REDACTED]`],
      [`${tokenKey}: Token k=test-value`, `${tokenKey}: [REDACTED]`],
      [`${accessKey}: Bearer abc.${tokenKey}=`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Basic admin:my${tokenKey}=`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Basic admin:my${tokenKey}=x`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Bearer test/${tokenKey}=`, `${accessKey}: [REDACTED]`],
      // Masking stops at the end of the line.
      [`${accessKey}: Bearer sv=1&sig=${sig}\nstatus=401`, `${accessKey}: [REDACTED]\nstatus=401`],
      // Round 15: a sensitive key/value at the next token is masked to the end of the line.
      [`${PW}=basic ${tokenKey}: ${hidden}`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${tokenKey}= ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic "${tokenKey}" = ${hidden} q=x`, `${PW}=[REDACTED]`],
      // A credential without = or : keeps later fields readable.
      [`${accessKey}: Bearer test-x status=401`, `${accessKey}: [REDACTED] status=401`],
      [`${PW}=basic ${btoa("test")} next`, `${PW}=[REDACTED] next`],
      // Authorization keys are unchanged.
      ["Authorization: Bearer test-token", "Authorization: Bearer [REDACTED]"],
      [`Authorization: Basic ${btoa("test")}`, "Authorization: Basic [REDACTED]"],
      [`Authorization: bearer ${tokenKey}=`, "Authorization: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      expect(output).not.toContain(sig);
      expect(output).not.toContain(hidden);
    }
  });

  it("decides non-authorization scheme words in linear time", () => {
    expectLinearScaling(64_000, (n) => {
      expect(redactSensitiveString(`${accessKey}: Bearer sv=1&x `.repeat(n))).toBe(`${accessKey}: [REDACTED]`);
      expect(redactSensitiveString(`${accessKey}: Bearer sv=1&x\n`.repeat(n))).not.toContain("sv=1");
      expect(redactSensitiveString(`${PW}=basic "${tokenKey}" = `.repeat(n))).not.toContain("basic");
      expect(redactSensitiveString(`${PW}=basic "${tokenKey}" = "${"a".repeat(3 * n)}`)).toBe(`${PW}=[REDACTED]`);
    });
  }, SCALING_TIMEOUT);
});

describe("round-14 token after a scheme word that may itself be the credential", () => {
  const tokenKey = ["to", "ken"].join("");
  const accessKey = ["access", "Token"].join("");
  const hidden = ["test", "hidden"].join("-");
  const abcToken = ["abc", "Token"].join("");
  const abcSecret = ["abc", "Secret"].join("");
  const fToken = ["f", tokenKey].join("");
  const yxToken = ["YX_", tokenKey].join("");
  const apiKey = ["api", "key"].join("_");
  const myToken = ["my", tokenKey].join("");
  const userPass = [apiKey, "test-pass"].join(":");

  it("masks a credential-shaped or user:pass-shaped token together with the scheme word", () => {
    const cases: Array<[string, string]> = [
      [`${accessKey}: Bearer ${abcToken}= status=401`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Bearer ${abcToken}=\nstatus=401`, `${accessKey}: [REDACTED]\nstatus=401`],
      [`${accessKey}: Bearer ${abcSecret}= status=401`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Bearer ${fToken}==`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Basic ${yxToken}==`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Basic ${userPass}`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Basic ${userPass} q=1`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Basic admin:${myToken}=`, `${accessKey}: [REDACTED]`],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      for (const word of [abcToken, abcSecret, fToken, yxToken, apiKey, myToken, "test-pass"]) {
        expect(output).not.toContain(word);
      }
    }
  });

  it("keeps the other scheme-word outcomes", () => {
    const cases: Array<[string, string]> = [
      // Round 15: a key/value after the word is masked to the end of the line.
      [`${PW}=basic ${tokenKey}= ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${tokenKey} = ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${tokenKey}: ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic "${tokenKey}" = ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic '${tokenKey}'= ${hidden} q=x`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${tokenKey}=hid,next=1`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${tokenKey}=`, `${PW}=[REDACTED]`],
      [`${accessKey}: Bearer test-x status=401`, `${accessKey}: [REDACTED] status=401`],
      [`${PW}=basic ${btoa("test")} next`, `${PW}=[REDACTED] next`],
      // Authorization keys are unchanged.
      ["Authorization: Bearer test-token", "Authorization: Bearer [REDACTED]"],
      [`Authorization: Basic ${btoa("test")}`, "Authorization: Basic [REDACTED]"],
      [`Authorization: bearer ${tokenKey}=`, "Authorization: [REDACTED]"],
      [`Authorization: bearer ${abcToken}= status=401`, "Authorization: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      expect(output).not.toContain(hidden);
    }
  });

  it("masks ambiguous tokens after scheme words in linear time", () => {
    expectLinearScaling(64_000, (n) => {
      expect(redactSensitiveString(`${accessKey}: Bearer ${abcToken}= x `.repeat(n))).not.toContain(abcToken);
      expect(redactSensitiveString(`${accessKey}: Basic ${userPass} `.repeat(n))).not.toContain(apiKey);
    });
  }, SCALING_TIMEOUT);
});

describe("round-15 scanning never resumes inside the text after a scheme word", () => {
  const tokenKey = ["to", "ken"].join("");
  const accessKey = ["access", "Token"].join("");
  const abcToken = ["abc", tokenKey].join("");
  const apiKey = ["api", "key"].join("_");
  const authKey = ["Author", "ization"].join("");
  const secret = ["test", "secret"].join("-");
  const sig = ["test", "sig"].join("-");
  const last = ["test", "last"].join("-");
  const response = ["test", "response"].join("-");
  const apiKeyValue = ["test", "key"].join("-");

  it("masks everything after a standing-alone scheme word on its line", () => {
    const cases: Array<[string, string]> = [
      [`${accessKey}: Bearer ${abcToken}= ${PW}: ${secret}`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Bearer ${abcToken}=\n${PW}: ${secret}`, `${accessKey}: [REDACTED]\n${PW}: [REDACTED]`],
      [`${accessKey}: Bearer ${abcToken}=\nstatus=401`, `${accessKey}: [REDACTED]\nstatus=401`],
      [`${PW}=basic ${tokenKey}= ${apiKey}= ${secret}`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${tokenKey}= ${apiKey}=${secret}`, `${PW}=[REDACTED]`],
      [`${accessKey}: Basic ${apiKey}:'x'&sig=${last}`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Bearer "${abcToken}=" status=401`, `${accessKey}: [REDACTED]`],
      [`${PW}=basic ${tokenKey}= bearer status=401 sig=${sig}`, `${PW}=[REDACTED]`],
      [`${PW}=${tokenKey} ${authKey}= Digest response="${response}"`, `${PW}=[REDACTED]`],
      [`${PW}=basic ${authKey.toLowerCase()}:ApiKey ${apiKeyValue}`, `${PW}=[REDACTED]`],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      for (const value of [secret, sig, last, response, apiKeyValue, abcToken]) {
        expect(output).not.toContain(value);
      }
    }
  });

  it("keeps the credential and authorization outcomes of earlier rounds", () => {
    const cases: Array<[string, string]> = [
      [`${accessKey}: Bearer test-x status=401`, `${accessKey}: [REDACTED] status=401`],
      [`${PW}=basic ${btoa("test")} next`, `${PW}=[REDACTED] next`],
      ["Authorization: Bearer test-token\nnext=line", "Authorization: Bearer [REDACTED]\nnext=line"],
      [`Authorization: Basic ${btoa("test")}`, "Authorization: Basic [REDACTED]"],
      [`Authorization: bearer ${tokenKey}=`, "Authorization: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("masks to the end of the line in linear time", () => {
    expectLinearScaling(64_000, (n) => {
      expect(redactSensitiveString(`${accessKey}: Bearer ${abcToken}= ${PW}: x\n`.repeat(n))).not.toContain(abcToken);
      expect(redactSensitiveString(`${PW}=basic ${tokenKey}= ${apiKey}= x `.repeat(n))).toBe(`${PW}=[REDACTED]`);
    });
  }, SCALING_TIMEOUT);
});

describe("round-16 text after a scheme word is printed only outside the credential", () => {
  const accessKey = ["access", "Token"].join("");
  const credential = ["test", "credential"].join("-");
  const first = ["test", "first"].join("-");
  const last = ["test", "last"].join("-");
  const partA = ["test", "a"].join("-");
  const partB = ["test", "b"].join("-");
  const leaked = [credential, last, partA, partB];

  it("masks folded continuation lines after a value that is only a scheme word", () => {
    const cases: Array<[string, string]> = [
      [`Authorization: Bearer\r\n ${credential}\r\nstatus=401`, "Authorization: [REDACTED]\r\nstatus=401"],
      [`Authorization: Bearer\n ${credential}\nstatus=401`, "Authorization: [REDACTED]\nstatus=401"],
      [`Authorization: Bearer \n ${credential}`, "Authorization: [REDACTED]"],
      [`Authorization: Bearer\n\n ${credential}`, "Authorization: [REDACTED]"],
      [`Authorization: Bearer\n \t\n ${credential}\n\nnext=1`, "Authorization: [REDACTED]\n\nnext=1"],
      [`Authorization: Bearer\n ${partA}\n\t${partB}\nstatus=401`, "Authorization: [REDACTED]\nstatus=401"],
      [`${PW}=basic\n ${credential}`, `${PW}=[REDACTED]`],
      [`${accessKey}: Bearer\n\t${credential}`, `${accessKey}: [REDACTED]`],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      for (const value of leaked) expect(output).not.toContain(value);
    }
  });

  it("masks a non-credential-token value after a scheme word to the end of the line", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic "${first} ${last}" q=ok`, `${PW}=[REDACTED]`],
      [`${PW}=basic 'a ${last}' q=ok`, `${PW}=[REDACTED]`],
      [`${accessKey}: Bearer "${first} ${last}" q=ok`, `${accessKey}: [REDACTED]`],
      [`${accessKey}: Basic ${["user", last].join(":")} q=1`, `${accessKey}: [REDACTED]`],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      for (const value of leaked) expect(output).not.toContain(value);
    }
  });

  it("keeps column-0 next lines and the outcomes of earlier rounds", () => {
    const cases: Array<[string, string]> = [
      ["Authorization: Bearer\nstatus=401", "Authorization: [REDACTED]\nstatus=401"],
      ["Authorization: Bearer\r\nstatus=401", "Authorization: [REDACTED]\r\nstatus=401"],
      ["Authorization: Bearer\n\nstatus=401", "Authorization: [REDACTED]\n\nstatus=401"],
      ["Authorization:\tBasic\ttest-leak\nstatus=401", "Authorization:\tBasic\t[REDACTED]\nstatus=401"],
      [`${accessKey}: Bearer test-x status=401`, `${accessKey}: [REDACTED] status=401`],
      [`${PW}=basic ${btoa("test")} next`, `${PW}=[REDACTED] next`],
      [`${PW}: bearer`, `${PW}: [REDACTED]`],
      [`${PW}: bearer\nnext=1`, `${PW}: [REDACTED]\nnext=1`],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("masks folded lines and non-token values in linear time", () => {
    expectLinearScaling(64_000, (n) => {
      expect(redactSensitiveString("Authorization: Bearer\n x\n".repeat(n))).toBe("Authorization: [REDACTED]\n".repeat(n));
      expect(redactSensitiveString(`${PW}=basic "a b" q=1 `.repeat(n))).toBe(`${PW}=[REDACTED]`);
      const blanks = " \n".repeat(3 * n);
      expect(redactSensitiveString(`${PW}=basic\n${blanks}x`)).toBe(`${PW}=[REDACTED]\n${blanks}x`);
    });
  }, SCALING_TIMEOUT);
});

describe("round-17 folded continuation lines belong to the credential they continue", () => {
  const accessKey = ["access", "Token"].join("");
  const continuation = ["test", "continuation"].join("-");
  const response = ["test", "response"].join("-");
  const tail = ["test", "y"].join("-");
  const leaked = [continuation, response, tail];

  it("masks folded lines after an authorization value and after a scheme word with its token", () => {
    const cases: Array<[string, string]> = [
      [`Authorization: Bearer test-token\r\n ${continuation}\r\nstatus=401`, "Authorization: Bearer [REDACTED]\r\nstatus=401"],
      [`Authorization: Bearer test-token\n ${continuation}\nstatus=401`, "Authorization: Bearer [REDACTED]\nstatus=401"],
      [`Authorization: Bearer test-token \n\n\t${continuation}\nstatus=401`, "Authorization: Bearer [REDACTED]\nstatus=401"],
      [`Authorization: Digest username="u",\n  response="${response}"\nnext=1`, "Authorization: [REDACTED]\nnext=1"],
      [`${accessKey}: Bearer test-x\n ${tail}\nq=1`, `${accessKey}: [REDACTED]\nq=1`],
      [`${accessKey}: Bearer test-x \r\n\t${tail}`, `${accessKey}: [REDACTED]`],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      for (const value of leaked) expect(output).not.toContain(value);
    }
  });

  it("keeps column-0 lines, later fields on the same line and indented lines after values without a scheme", () => {
    const cases: Array<[string, string]> = [
      ["Authorization: Bearer test-token\nstatus=401", "Authorization: Bearer [REDACTED]\nstatus=401"],
      ["Authorization: Bearer test-token\n\nstatus=401", "Authorization: Bearer [REDACTED]\n\nstatus=401"],
      [`${accessKey}: Bearer test-x status=401\n next=1`, `${accessKey}: [REDACTED] status=401\n next=1`],
      [`${PW}=test-value\n indented=1`, `${PW}=[REDACTED]\n indented=1`],
      [`${PW}=basic ${btoa("test")} next`, `${PW}=[REDACTED] next`],
      [`${PW}: bearer`, `${PW}: [REDACTED]`],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("checks for folded lines in linear time on long lines and long blank runs", () => {
    expectLinearScaling(64_000, (n) => {
      expect(redactSensitiveString(`${"token=basic; ".repeat(n)}x`)).toBe(`${"token=[REDACTED]; ".repeat(n)}x`);
      const url = redactSensitive(new URL(`https://example.test/#${"token=basic;&".repeat(n)}q=ok`));
      expect(String(url)).toContain("q=ok");
      expect(String(url)).not.toContain("basic");
      expect(redactSensitiveString("Authorization: Bearer x\n\n".repeat(n))).toBe(
        "Authorization: Bearer [REDACTED]\n\n".repeat(n),
      );
      expect(redactSensitiveString("Authorization: Bearer\n x\n".repeat(n))).toBe("Authorization: [REDACTED]\n".repeat(n));
      const blankRun = "\n".repeat(4 * n);
      expect(redactSensitiveString(`Authorization: Bearer x${blankRun}next=1`)).toBe(
        `Authorization: Bearer [REDACTED]${blankRun}next=1`,
      );
    });
  }, SCALING_TIMEOUT);
});

describe("round-18 quoted values across & after escaped keys, decoded re-checks and unclosed quoted folds", () => {
  const first = ["test", "first"].join("-");
  const last = ["test", "last"].join("-");
  const second = ["test", "second"].join("-");
  const response = ["test", "response"].join("-");
  const tail = ["test", "x"].join("-");
  const escapedKey = "pass%77ord";
  const tokenKey = ["to", "ken"].join("");
  const href = (suffix: string) => String(redactSensitive(new URL(`https://example.test/${suffix}`)));

  it("masks a quoted value after an escaped sensitive key as one value across &", () => {
    const cases: Array<[string, string]> = [
      [`#${escapedKey}=%22${first}&chunk=${last}%22&q=ok`, `#${escapedKey}=%22[REDACTED]%22&q=ok`],
      [`#${escapedKey}='${first}&chunk=${last}'&state=ok`, `#${escapedKey}='[REDACTED]'&state=ok`],
      [`#${escapedKey}:'${first}&chunk=${last}'&state=ok`, "#[REDACTED]&state=ok"],
      [`?${escapedKey}=%27${first}&chunk=${last}%27&state=ok`, `?${escapedKey}=%27[REDACTED]%27&state=ok`],
      [`?user%255B${PW}%255D=%27a&${last}%27&state=ok`, `?user%255B${PW}%255D=%27[REDACTED]%27&state=ok`],
      [`#${escapedKey}='${first}&chunk=${last}`, `#${escapedKey}='[REDACTED]`],
    ];
    for (const [suffix, expected] of cases) {
      const output = href(suffix);
      expect(output).toBe(`https://example.test/${expected}`);
      expect(output).not.toContain(last);
      expect(output).not.toContain(first);
    }
  });

  it("keeps raw-key quoted values, unquoted escaped keys and other parameters as before", () => {
    const cases: Array<[string, string]> = [
      [`#${tokenKey}='${first}&chunk=${last}'&state=ok`, `#${tokenKey}='[REDACTED]'&state=ok`],
      [`?${escapedKey}=x&q=ok`, `?${escapedKey}=[REDACTED]&q=ok`],
      ["#note='a&b'&q=1", "#note='a&b'&q=1"],
      ["#/callback?state=ok", "#/callback?state=ok"],
    ];
    for (const [suffix, expected] of cases) {
      expect(href(suffix)).toBe(`https://example.test/${expected}`);
    }
  });

  it("checks the decoded form of a URLSearchParams value after the string pass masked part of it", () => {
    const escaped = new URLSearchParams([["note", `${tokenKey}=a,${tokenKey}%3D${second}`], ["q", "ok"]]);
    const output = redactSensitive(escaped);
    expect(output).toBe("note=[REDACTED]&q=ok");
    expect(output).not.toContain(second);
    const plain = new URLSearchParams([["note", `${tokenKey}=a ${tokenKey}=${second}`], ["q", "ok"]]);
    expect(redactSensitive(plain)).toBe(`note=${tokenKey}%3D[REDACTED]+${tokenKey}%3D[REDACTED]&q=ok`);
  });

  it("masks folded lines after an unclosed quoted authorization or scheme-labelled value", () => {
    const cases: Array<[string, string]> = [
      [`Authorization: "Bearer ${first}\r\n ${last}" q=ok`, 'Authorization: "[REDACTED]'],
      [`Authorization: 'Digest username="u",\n  response="${response}"'\nnext=1`, "Authorization: '[REDACTED]\nnext=1"],
      [`${tokenKey}: "Bearer\n ${tail}"`, `${tokenKey}: "[REDACTED]`],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      for (const value of [last, response, tail]) expect(output).not.toContain(value);
    }
  });

  it("keeps closed quoted values and unclosed values without a scheme unfolded", () => {
    const cases: Array<[string, string]> = [
      [`Authorization: "Bearer ${tail}" q=ok`, 'Authorization: "[REDACTED]" q=ok'],
      [`${PW}: "test-v"\n indented=1`, `${PW}: "[REDACTED]"\n indented=1`],
      [`${PW}: "test-v\n indented=1`, `${PW}: "[REDACTED]\n indented=1`],
      ['{"authorization": "Bearer x"\n  }', '{"authorization": "[REDACTED]"\n  }'],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
  });

  it("scans quoted URL values across & in linear time", () => {
    expectLinearScaling(64_000, (n) => {
      // n is even: each later part closes the quote the part before opened.
      expect(href(`#${`${escapedKey}='a&`.repeat(n)}`)).toBe(`https://example.test/#${escapedKey}=[REDACTED]&`);
      // Each part after a closed value leaves a quote of the same form open,
      // so the span continues (fail closed) and the trailing empty part stays.
      expect(href(`?${`${escapedKey}=%27&`.repeat(n)}`)).toBe(`https://example.test/?${escapedKey}=%27[REDACTED]%27&`);
    });
  }, SCALING_TIMEOUT);
});

describe("round-19 quoted URL values judged on decoded text and blanks after a scheme word", () => {
  const first = ["test", "first"].join("-");
  const last = ["test", "last"].join("-");
  const secret = ["test", "secret"].join("-");
  const credential = ["test", "token"].join("-");
  const escapedKey = "pass%77ord";
  const tokenKey = ["to", "ken"].join("");
  const href = (suffix: string) => String(redactSensitive(new URL(`https://example.test/${suffix}`)));

  it("masks a quoted secret value across & however its quote reaches the redactor", () => {
    const cases: Array<[string, string]> = [
      // A quote after an encoded, plus or double-encoded blank.
      [`#${escapedKey}=%20%22${first}&chunk=${last}%22&q=ok`, `#${escapedKey}=[REDACTED]&q=ok`],
      [`#${escapedKey}=+'${first}&chunk=${last}'&q=ok`, `#${escapedKey}=[REDACTED]&q=ok`],
      [`#${escapedKey}=%2520%2522${first}&chunk=${last}%2522&q=ok`, `#${escapedKey}=[REDACTED]&q=ok`],
      // A quote the string pass would consume before a comma or semicolon.
      [`?${tokenKey}='${first},x&chunk=${last}'&q=ok`, `?${tokenKey}='[REDACTED]'&q=ok`],
      [`#${tokenKey}=%22${first};x&chunk=${last}%22&q=ok`, `#${tokenKey}="[REDACTED]"&q=ok`],
      // A backslash-escaped quote does not close the value.
      [`#${escapedKey}='${first}&mid=a\\'&tail=${last}'&state=ok`, `#${escapedKey}='[REDACTED]'&state=ok`],
      // A quoted secret inside an escaped value.
      [`?note=${escapedKey}%3D'${first}&chunk=${last}'&state=ok`, "?note=[REDACTED]&state=ok"],
    ];
    for (const [suffix, expected] of cases) {
      const output = href(suffix);
      expect(output).toBe(`https://example.test/${expected}`);
      expect(output).not.toContain(last);
      expect(output).not.toContain(first);
    }
  });

  it("keeps unquoted, closed and non-secret parameters as before", () => {
    const cases: Array<[string, string]> = [
      [`#${tokenKey}:'${first}&chunk=${last}'&state=ok`, `#${tokenKey}:'[REDACTED]'&state=ok`],
      [`#${escapedKey}=%22${first}&chunk=${last}%22&q=ok`, `#${escapedKey}=%22[REDACTED]%22&q=ok`],
      [`?${escapedKey}=x&q=ok`, `?${escapedKey}=[REDACTED]&q=ok`],
      ["#note='a&b'&q=1", "#note='a&b'&q=1"],
      ["?note=it's&q=1", "?note=it%27s&q=1"],
      ["#/callback?state=ok", "#/callback?state=ok"],
    ];
    for (const [suffix, expected] of cases) {
      expect(href(suffix)).toBe(`https://example.test/${expected}`);
    }
    const embedded = ["us&er", `${first}&x`].join(":");
    const withUserinfo = String(redactSensitive(new URL(`https://${embedded}@example.test/?q=1`)));
    expect(withUserinfo).toBe("https://[REDACTED]@example.test/?q=1");
  });

  it("treats any whitespace but a line break after a scheme word as a blank", () => {
    const cases: Array<[string, string]> = [
      [`accessToken: Bearer ${secret} q=1`, "accessToken: [REDACTED] q=1"],
      [`${PW}=basic\u000b${secret}`, `${PW}=[REDACTED]`],
      [`Authorization: Bearer ${credential}\nstatus=401`, "Authorization: Bearer [REDACTED]\nstatus=401"],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      expect(output).not.toContain(secret);
      expect(output).not.toContain(credential);
    }
  });

  it("scans decoded quoted URL values across & in linear time", () => {
    expectLinearScaling(64_000, (n) => {
      expect(href(`#${`${escapedKey}=%20'a&`.repeat(n)}`)).toBe(`https://example.test/#${escapedKey}=[REDACTED]&`);
      expect(href(`?${`note=${escapedKey}%3D'a&`.repeat(n)}`)).toBe("https://example.test/?note=[REDACTED]&");
    });
  }, SCALING_TIMEOUT);
});

describe("round-20 URL parameters judged on their original decoded text and blanks before a quoted scheme word", () => {
  const first = ["test", "first"].join("-");
  const last = ["test", "last"].join("-");
  const tail = ["test", "tail"].join("-");
  const secret = ["test", "secret"].join("-");
  const escapedKey = "pass%77ord";
  const tokenKey = ["to", "ken"].join("");
  const authorizationKey = ["Author", "ization"].join("");
  const accessKey = ["access", "Token"].join("");
  const href = (suffix: string) => String(redactSensitive(new URL(`https://example.test/${suffix}`)));

  it("masks a quote after an escaped backslash or a scheme word, and escaped single-part values, before the string pass", () => {
    const cases: Array<[string, string[]]> = [
      // An escaped backslash before a quote does not close the value.
      [`#${tokenKey}='${first}&mid=a%5C'&tail=${tail}'&state=ok`, [`#${tokenKey}='[REDACTED]'&state=ok`]],
      // A quote after a scheme word opens a value that spans &.
      [`#${escapedKey}=Bearer%20'${first}&chunk=${last}'&q=ok`, [`#${escapedKey}=[REDACTED]&q=ok`]],
      [`#${authorizationKey}%3A%20Bearer%20%27${first}&chunk=${last}%27&q=ok`, ["#[REDACTED]&q=ok"]],
      // An escaped quoted value in one part: the raw pass never sees it.
      [`#${tokenKey}:%27${first};${last}%27&state=ok`, ["#[REDACTED]&state=ok", `#${tokenKey}:[REDACTED]&state=ok`]],
      [`?note=${tokenKey}=%27${first};${last}%27&q=ok`, ["?note=[REDACTED]&q=ok"]],
      // A closing quote followed by an escaped blank still closes the value.
      [`#${escapedKey}=%27${first}&chunk=${tail}%27%20&state=ok`, [`#${escapedKey}=[REDACTED]&state=ok`]],
    ];
    for (const [suffix, expected] of cases) {
      const output = href(suffix);
      expect(expected.map((value) => `https://example.test/${value}`)).toContain(output);
      for (const value of [first, last, tail]) expect(output).not.toContain(value);
    }
  });

  it("judges URLSearchParams entries on their original decoded key and value", () => {
    const cases: Array<[Array<[string, string]>, string]> = [
      [[["note", `${tokenKey}=%27${first};${secret}%27`], ["q", "ok"]], "note=[REDACTED]&q=ok"],
      [[["note", `${tokenKey}=%20%22${first};${secret}%22`], ["q", "ok"]], "note=[REDACTED]&q=ok"],
      [[[`${tokenKey}:%27${first};${secret}%27`, "1"], ["q", "ok"]], "[REDACTED]&q=ok"],
    ];
    for (const [entries, expected] of cases) {
      const output = redactSensitive(new URLSearchParams(entries));
      expect(output).toBe(expected);
      expect(output).not.toContain(secret);
    }
  });

  it("masks folded lines after a quoted value whose scheme word follows blanks", () => {
    const cases: Array<[string, string]> = [
      [`${tokenKey}: " Bearer ${first}\n ${last}" q=ok`, `${tokenKey}: "[REDACTED]`],
      [`${accessKey}: "\tBearer ${first}\r\n ${last}"`, `${accessKey}: "[REDACTED]`],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      expect(output).not.toContain(last);
    }
  });

  it("keeps non-secret, closed and unfolded values as before", () => {
    const urls: Array<[string, string]> = [
      ["#note='a&b'&q=1", "#note='a&b'&q=1"],
      ["#/callback?state=ok", "#/callback?state=ok"],
      ["?note=it's&q=1", "?note=it%27s&q=1"],
      ["?a=1&&b=%2B+c#/r?x=1&&y", "?a=1&&b=%2B+c#/r?x=1&&y"],
      [`#${tokenKey}:'${first}&chunk=${last}'&state=ok`, `#${tokenKey}:'[REDACTED]'&state=ok`],
    ];
    for (const [suffix, expected] of urls) {
      expect(href(suffix)).toBe(`https://example.test/${expected}`);
    }
    const plain = new URLSearchParams([["note", `${tokenKey}=a ${tokenKey}=${secret}`], ["q", "ok"]]);
    expect(redactSensitive(plain)).toBe(`note=${tokenKey}%3D[REDACTED]+${tokenKey}%3D[REDACTED]&q=ok`);
    expect(redactSensitiveString(`${PW}: "test-v"\n indented=1`)).toBe(`${PW}: "[REDACTED]"\n indented=1`);
    expect(redactSensitiveString(`${PW}: "test-v\n indented=1`)).toBe(`${PW}: "[REDACTED]\n indented=1`);
  });

  it("judges escaped and quoted URL parameters in linear time", () => {
    expectLinearScaling(64_000, (n) => {
      expect(href(`#${`${tokenKey}='a%5C'&`.repeat(n)}`)).toBe(`https://example.test/#${tokenKey}='[REDACTED]'&`);
      expect(href(`?${`note=${tokenKey}%3D%27a;b%27&`.repeat(n)}`)).toBe(
        `https://example.test/?${"note=[REDACTED]&".repeat(n)}`,
      );
    });
  }, SCALING_TIMEOUT);
});

describe("round-21 quoted URL secrets judged from their own value and embedded userinfo masked first", () => {
  const first = ["test", "first"].join("-");
  const last = ["test", "last"].join("-");
  const secret = ["test", "secret"].join("-");
  const escapedKey = "pass%77ord";
  const tokenKey = ["to", "ken"].join("");
  const myTokenKey = ["my", "token"].join("");
  const href = (suffix: string) => String(redactSensitive(new URL(`https://example.test/${suffix}`)));
  const embedded = (user: string, rest: string) => [user, rest].join(":");

  it("ignores quotes before the secret's value and closes a span only on a quote written in the same form", () => {
    const cases: Array<[string, string]> = [
      [`?note=it's%20${tokenKey}=%27${first}&chunk=${last}%27&q=ok`, "?note=[REDACTED]&q=ok"],
      [`#note=a'b'c'%20${tokenKey}='${first}&chunk=${last}'&q=ok`, "#note=[REDACTED]&q=ok"],
      [
        `#/it's?${escapedKey}=%27${first}&chunk=${last}%27&state=ok`,
        `#/it's?${escapedKey}=%27[REDACTED]%27&state=ok`,
      ],
      [`?note=%22hi%20${tokenKey}='${first}&mid=x%22&tail=${last}'&state=ok`, "?note=[REDACTED]&state=ok"],
      // An escaped quote does not close a value opened by a literal quote.
      [`#${tokenKey}='${first}&mid=test%27&part=${last}'&state=ok`, `#${tokenKey}='[REDACTED]'&state=ok`],
    ];
    for (const [suffix, expected] of cases) {
      const output = href(suffix);
      expect(output).toBe(`https://example.test/${expected}`);
      expect(output).not.toContain(last);
    }
  });

  it("masks embedded URL and Postgres userinfo before any parameter is rewritten", () => {
    const withEscapedKey = embedded("test-user", `${first}&${escapedKey}=${last}`);
    const withRawKey = embedded("svc", `${myTokenKey}=a%20b&${secret}`);
    const cases: Array<[string, string]> = [
      [
        `#next=https://${withEscapedKey}@api.example.test/path&state=ok`,
        "#next=https://[REDACTED]&state=ok",
      ],
      [`?next=https://${withRawKey}@db.example.test/&q=x`, "?next=https://[REDACTED]&q=x"],
      [`#https://${embedded("svc", `${tokenKey}:a%20b&${secret}`)}@db.example.test/`, "#https://[REDACTED]"],
      [`#next=postgres://${withRawKey}@db.example.test/&q=x`, "#next=postgres://[REDACTED]&q=x"],
      [`#next=postgres://${withEscapedKey}@db.example.test/&q=x`, "#next=postgres://[REDACTED]&q=x"],
    ];
    for (const [suffix, expected] of cases) {
      const output = href(suffix);
      expect(output).toBe(`https://example.test/${expected}`);
      for (const hidden of [first, last, secret, "a%20b"]) expect(output).not.toContain(hidden);
    }
  });

  it("keeps the earlier URL outputs", () => {
    const urls: Array<[string, string]> = [
      ["#note='a&b'&q=1", "#note='a&b'&q=1"],
      ["#/callback?state=ok", "#/callback?state=ok"],
      [`#${tokenKey}='${first}&mid=a%5C'&tail=${last}'&state=ok`, `#${tokenKey}='[REDACTED]'&state=ok`],
      [`#${escapedKey}=%20%22${first}&chunk=${last}%22&q=ok`, `#${escapedKey}=[REDACTED]&q=ok`],
      [`#${tokenKey}:%27${first};${last}%27&state=ok`, "#[REDACTED]&state=ok"],
      ["?next=https://api.example.test&email=a@b.test", "?next=https://[REDACTED]@b.test"],
    ];
    for (const [suffix, expected] of urls) {
      expect(href(suffix)).toBe(`https://example.test/${expected}`);
    }
  });

  it("scans embedded userinfo and same-form closing quotes in linear time", () => {
    const part = `next=https://${embedded("u", "x&y")}@h&`;
    expectLinearScaling(64_000, (n) => {
      // n is even; a literal quote closes the span, %27 does not.
      expect(href(`#${`${tokenKey}='a&b%27&`.repeat(n)}`)).toBe(
        `https://example.test/#${`${tokenKey}='[REDACTED]'&b%27&`.repeat(n / 2)}`,
      );
      expect(href(`?${part.repeat(n)}`)).toBe(`https://example.test/?${"next=https://[REDACTED]@h&".repeat(n)}`);
    });
  }, SCALING_TIMEOUT);
});

describe("round-22 one quote state machine per URL secret and fail-closed userinfo in both entry points", () => {
  const first = ["test", "first"].join("-");
  const last = ["test", "last"].join("-");
  const value = ["test", "value"].join("-");
  const escapedKey = "pass%77ord";
  const tokenKey = ["to", "ken"].join("");
  const myTokenKey = ["my", "token"].join("");
  const href = (suffix: string) => String(redactSensitive(new URL(`https://example.test/${suffix}`)));
  const embedded = (user: string, rest: string) => [user, rest].join(":");

  it("opens and closes a quoted URL value only on the same quote at the same escape depth", () => {
    const cases: Array<[string, string]> = [
      [`#note=%22hi%20${tokenKey}='${first}%27&tail=${last}'&q=ok`, "#note=[REDACTED]&q=ok"],
      [`#${escapedKey}='${first}%27&tail=${last}'&q=ok`, `#${escapedKey}='[REDACTED]'&q=ok`],
      // A close and a reopen inside one part keep the value open.
      [`#${escapedKey}='${first}&mid=a'b'&tail=${last}'&state=ok`, `#${escapedKey}='[REDACTED]'&state=ok`],
      [`#${escapedKey}=%27${first}'&chunk=${last}%27&state=ok`, `#${escapedKey}=%27[REDACTED]%27&state=ok`],
      // In a query the URL serialiser writes both quotes as %27, so the value
      // reads as closed in its own part; the next part's unmatched quote of the
      // same form continues it, failing closed to the end of the query.
      [`?note=${tokenKey}%3D'${first}%27&chunk=${last}'&state=ok`, "?note=[REDACTED]"],
    ];
    for (const [suffix, expected] of cases) {
      const output = href(suffix);
      expect(output).toBe(`https://example.test/${expected}`);
      expect(output).not.toContain(last);
    }
  });

  it("masks userinfo that holds a secret with the run after its @ in URLs and strings", () => {
    const valueAt = [value, "test-ret"].join("@");
    const quotedAt = [`%27${value};x`, "mid"].join("@");
    const withRawKey = embedded("test-user", `test-prefix&${myTokenKey}=a%20b&test-tail`);
    const urls: Array<[string, string]> = [
      [`?next=https://a.test&${escapedKey}=${valueAt}&q=1`, "?next=https://[REDACTED]&q=1"],
      [`#next=https://a.test&${tokenKey}=${quotedAt}&tail=${last}%27&q=1`, "#next=https://[REDACTED]&q=1"],
      [`?next=https://${withRawKey}@db.example.test/path&q=x`, "?next=https://[REDACTED]&q=x"],
    ];
    for (const [suffix, expected] of urls) {
      const output = href(suffix);
      expect(output).toBe(`https://example.test/${expected}`);
      for (const hidden of [value, "test-ret", "mid", last, "test-prefix", "test-tail"]) {
        expect(output).not.toContain(hidden);
      }
    }
    const message = `connect https://${withRawKey}@db.example.test/path failed`;
    const output = redactSensitiveString(message);
    expect(output).toBe("connect https://[REDACTED] failed");
    expect(output).not.toContain("test-prefix");
    expect(output).not.toContain("test-tail");
  });

  it("keeps the host of userinfo without a secret and the earlier URL outputs", () => {
    const plain = embedded("test-user", "test-pass");
    expect(redactSensitiveString(`connect https://${plain}@db.example.test/path failed`)).toBe(
      "connect https://[REDACTED]@db.example.test/path failed",
    );
    expect(redactSensitiveString(`connect postgres://${plain}@db.example.test/app failed`)).toBe(
      "connect postgres://[REDACTED]@db.example.test/app failed",
    );
    const urls: Array<[string, string]> = [
      [
        `#next=https://${plain}@api.example.test/path&state=ok`,
        "#next=https://[REDACTED]@api.example.test/path&state=ok",
      ],
      ["?next=https://api.example.test&email=a@b.test", "?next=https://[REDACTED]@b.test"],
      ["#note='a&b'&q=1", "#note='a&b'&q=1"],
      ["#/callback?state=ok", "#/callback?state=ok"],
    ];
    for (const [suffix, expected] of urls) {
      expect(href(suffix)).toBe(`https://example.test/${expected}`);
    }
  });

  it(
    "carries the quote state and masks userinfo in linear time",
    () => {
      const userinfoPart = `n=https://a.test&${escapedKey}=${["s", "r"].join("@")}&`;
      const message = `connect https://${embedded("u", `x&${myTokenKey}=a&y`)}@h/p failed `;
      expectLinearScaling(64_000, (n) => {
        // Each part closes the open quote and opens one at the other depth, so
        // the value never closes; in the second input n is even.
        expect(href(`#${`${escapedKey}='a%27&`.repeat(n)}`)).toBe(`https://example.test/#${escapedKey}='[REDACTED]`);
        expect(href(`#${`${escapedKey}='a'b'&`.repeat(n)}`)).toBe(`https://example.test/#${escapedKey}='[REDACTED]'&`);
        expect(href(`?${userinfoPart.repeat(n)}`)).toBe(`https://example.test/?${"n=https://[REDACTED]&".repeat(n)}`);
        expect(redactSensitiveString(message.repeat(n))).toBe("connect https://[REDACTED] failed ".repeat(n));
      });
    },
    SCALING_TIMEOUT,
  );
});

describe("round-23 only an authority's userinfo is masked first and never ends before the key/value mask", () => {
  const first = ["test", "first"].join("-");
  const middle = ["test", "middle"].join("-");
  const tail = ["test", "tail"].join("-");
  const secret = ["test", "secret"].join("-");
  const tokenKey = ["to", "ken"].join("");
  const authorizationKey = ["author", "ization"].join("");
  const href = (url: string) => String(redactSensitive(new URL(url)));
  const embedded = (user: string, rest: string) => [user, rest].join(":");

  it("never lets userinfo cross ?, # or a double quote in strings", () => {
    const cases: Array<[string, string]> = [
      [
        `request https://api.example.test?${tokenKey}='${[first, middle].join("@")}#${tail}' state=ok`,
        `request https://api.example.test?${tokenKey}='[REDACTED]' state=ok`,
      ],
      [
        `{"url":"https://api.example.test","${PW}":"${["user", `host ${secret}`].join("@")}"}`,
        `{"url":"https://api.example.test","${PW}":"[REDACTED]"}`,
      ],
      [
        `postgres://db.test?user=app&${PW}=@${secret} failed`,
        `postgres://db.test?user=app&${PW}=[REDACTED] failed`,
      ],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      for (const hidden of [first, middle, tail, secret]) expect(output).not.toContain(hidden);
    }
  });

  it("masks secret-holding userinfo through its quote and the key/value mask in strings", () => {
    const cases: Array<[string, string]> = [
      [`url=https://api.example.test,${tokenKey}='${["user", `host ${secret}`].join("@")}'`, "url=https://[REDACTED]"],
      [
        `x https://${embedded("a", `${authorizationKey}=Bearer`)}@h ${tail} more\nnext=1`,
        "x https://[REDACTED]\nnext=1",
      ],
      [`connect https://${embedded("u", `${tokenKey}=a`)}@h/p?x=1&q=${tail} failed`, "connect https://[REDACTED] failed"],
      [`connect https://${embedded("u", `${tokenKey}='a`)}@h ${tail}' failed`, "connect https://[REDACTED] failed"],
      [`x https://h,${tokenKey}='a@b ${tail}\nnext=1`, "x https://[REDACTED]\nnext=1"],
    ];
    for (const [input, expected] of cases) {
      const output = redactSensitiveString(input);
      expect(output).toBe(expected);
      expect(output).not.toContain(secret);
      expect(output).not.toContain(tail);
    }
  });

  it("masks a sensitive key with an empty value before the @ and quoted values across # in URLs", () => {
    const cases: Array<[string, string]> = [
      [
        `https://example.test/#next=https://api.example.test&${tokenKey}='${[first, middle].join("@")}#${tail}'&state=ok`,
        "https://example.test/#next=https://[REDACTED]&state=ok",
      ],
      [`https://example.test/?next=https://a.test&${tokenKey}=@${secret}&q=1`, "https://example.test/?next=https://[REDACTED]&q=1"],
      [`https://example.test/#next=https://a.test&${tokenKey}=x@h#${tail}&q=1`, "https://example.test/#next=https://[REDACTED]&q=1"],
      [`postgres://db.test?${PW}=@${secret}`, `postgres://db.test?${PW}=[REDACTED]`],
    ];
    for (const [url, expected] of cases) {
      const output = href(url);
      expect(output).toBe(expected);
      for (const hidden of [first, middle, tail, secret]) expect(output).not.toContain(hidden);
    }
  });

  it(
    "masks userinfo in linear time in both entry points",
    () => {
      const emptyValue = `https://a.test&${tokenKey}=@x `;
      const quoted = `${tokenKey}='a@b `;
      expectLinearScaling(64_000, (n) => {
        expect(redactSensitiveString(emptyValue.repeat(n))).toBe("https://[REDACTED] ".repeat(n));
        expect(redactSensitiveString(`x=https://h,${quoted.repeat(n)}`)).toBe("x=https://[REDACTED]");
        expect(href(`https://example.test/?${`n=${emptyValue.trim()}&`.repeat(n)}`)).toBe(
          `https://example.test/?${"n=https://[REDACTED]&".repeat(n)}`,
        );
        expect(href(`https://example.test/#x=https://h,${quoted.repeat(n)}`)).not.toContain("@b");
      });
    },
    SCALING_TIMEOUT,
  );
});
