import { describe, expect, it } from "vitest";
import { redactSensitive, redactSensitiveString } from "../src/index";

// Sensitive key words and URL userinfo are built at runtime so fixture strings
// are not mistaken for committed credentials.
const PW = ["pass", "word"].join("");
const userinfo = (secret: string) => ["user", secret].join(":");
const REDACTED_MARK = "[REDACTED]";

describe("auth scheme words as secret values", () => {
  it("redacts the scheme word as the value when a non-authorization key holds bearer, basic or token", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic connectionTimeout=5000`, `${PW}=[REDACTED] connectionTimeout=5000`],
      ["token=bearer connectionTimeout=5000", "token=[REDACTED] connectionTimeout=5000"],
      ["api_key=token connectionTimeout=5000", "api_key=[REDACTED] connectionTimeout=5000"],
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
    expect(redactSensitiveString(`${PW}=basic connectionTimeout=5000`)).toBe(`${PW}=[REDACTED] connectionTimeout=5000`);
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
    const routes = new URL(`https://example.test/#/${"x".repeat(48_000)}`);
    const params = new URL(`https://example.test/#/cb?${"q=1&".repeat(12_000)}state=ok`);
    const started = performance.now();
    expect(redactSensitive(routes)).toBe(routes.href);
    expect(redactSensitive(params)).toBe(params.href);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
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
    const fragmentAssign = new URL(`https://example.test/#${"token=x&".repeat(16_000)}`);
    const fragmentColon = new URL(`https://example.test/#${"token:x&".repeat(16_000)}`);
    const queryAssign = new URL(`https://example.test/?${"token=x&".repeat(16_000)}`);
    const started = performance.now();
    expect(redactSensitive(fragmentAssign)).toBe("https://example.test/#token=[REDACTED]");
    expect(redactSensitive(fragmentColon)).toBe("https://example.test/#token:[REDACTED]");
    expect(redactSensitive(queryAssign)).toBe("https://example.test/?token=[REDACTED]");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("ends a non-authorization value after a scheme word that precedes an assignment", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic token: test-hidden`, `${PW}=[REDACTED] token: [REDACTED]`],
      [`${PW}=basic connectionTimeout=5000`, `${PW}=[REDACTED] connectionTimeout=5000`],
      [`${PW}=token token=test-hidden q=x`, `${PW}=[REDACTED] token=[REDACTED] q=x`],
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

  it("ends a non-authorization value after the scheme word when a key/value starts next", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic ${tokenKey}= ${hidden} q=x`, `${PW}=[REDACTED] ${tokenKey}= [REDACTED] q=x`],
      [`${PW}=basic ${tokenKey} = ${hidden} q=x`, `${PW}=[REDACTED] ${tokenKey} = [REDACTED] q=x`],
      [`${PW}=basic ${tokenKey}: ${hidden}`, `${PW}=[REDACTED] ${tokenKey}: [REDACTED]`],
      [`${PW}=basic connectionTimeout=5000`, `${PW}=[REDACTED] connectionTimeout=5000`],
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

  it("treats a dotted, quoted or spaced assignment after a scheme word as a new key", () => {
    const cases: Array<[string, string]> = [
      [`${PW}=basic db.${PW} = ${hidden} q=x`, `${PW}=[REDACTED] db.${PW} = [REDACTED] q=x`],
      [`${PW}=basic "${tokenKey}" = ${hidden} q=x`, `${PW}=[REDACTED] "${tokenKey}" = [REDACTED] q=x`],
      [`${PW}=basic '${tokenKey}'= ${hidden} q=x`, `${PW}=[REDACTED] '${tokenKey}'= [REDACTED] q=x`],
      [`${PW}=basic status = 401`, `${PW}=[REDACTED] status = 401`],
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
    const started = performance.now();
    expect(redactSensitiveString(`${PW}=basic x.`.repeat(64_000))).not.toContain("basic");
    expect(redactSensitiveString(`${PW}=basic "${"a".repeat(200_000)}`)).toBe(`${PW}=[REDACTED]`);
    expect(redactSensitiveString(`authorization: bearer "${"a".repeat(200_000)}`)).toBe("authorization: [REDACTED]");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("never prints a sensitive value tail after an @", () => {
    const value = ["sec", "ret"].join("@");
    for (const delimiter of ["?", "#"]) {
      const url = new URL(`https://example.test/${delimiter}next=https://a.test&${tokenKey}=${value}&q=1`);
      const redacted = redactSensitive(url);
      expect(redacted).toBe(`https://example.test/${delimiter}next=https://a.test&${tokenKey}=[REDACTED]`);
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
    const long = "a=b&".repeat(32_000);
    const started = performance.now();
    expect(href(`?${long}#${long}`)).toBe(`https://example.test/?${long}#${long}`);
    expect(href(`#${"x".repeat(128_000)}`)).toBe(`https://example.test/#${"x".repeat(128_000)}`);
    expect(href(`?${`${tokenKey}%3Dx&`.repeat(16_000)}`)).toBe(
      `https://example.test/?${"[REDACTED]&".repeat(16_000)}`,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });
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
      [`${PW}=basic ${tokenKey}=`, `${PW}=[REDACTED] ${tokenKey}=`],
      // Earlier cases still hold.
      ["Authorization: Bearer test-token", "Authorization: Bearer [REDACTED]"],
      [`Authorization: Basic ${btoa("test")}`, "Authorization: Basic [REDACTED]"],
      [`${PW}=basic ${btoa("test")} next`, `${PW}=[REDACTED] next`],
      [`${PW}=basic connectionTimeout=5000`, `${PW}=[REDACTED] connectionTimeout=5000`],
      ["accessToken: Bearer test-token", "accessToken: [REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input)).toBe(expected);
    }
    expect(redactSensitiveString(`${PW}=basic ${tokenKey}=`)).not.toContain("basic");
  });

  it("decides scheme words before empty fields in linear time", () => {
    const started = performance.now();
    expect(redactSensitiveString("authorization: bearer x ".repeat(64_000))).toBe("authorization: bearer [REDACTED]");
    expect(redactSensitiveString(`${PW}=basic tok.`.repeat(64_000))).not.toContain("basic");
    expect(redactSensitiveString(`${PW}=basic ${tokenKey}= `.repeat(64_000))).not.toContain("basic");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
