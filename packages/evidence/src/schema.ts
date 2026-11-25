// The evidence record v1 JSON Schema as a module, so the package entry needs
// no JSON import. schema/evidence-record.v1.json is the same document; a test
// keeps the two identical.

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

export const evidenceRecordSchemaV1 = deepFreeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:superfunctions:evidence-record:v1",
  "title": "Superfunctions evidence record v1",
  "description": "A source-bound evidence record. Dates are RFC 3339 date-times with an offset. Four rules are beyond this schema; checkEvidenceCrossValues checks them next to it, and validateEvidenceRecord enforces them: unique subjectIds by exact string (Ajv 8 uniqueItems misses a repeated \"__proto__\"), unique artifactHashes[].path values, startedAt <= completedAt, and a leap second at a nonzero offset falling on a leap second UTC inserted. Patterns use no lookaround and no Unicode escape, and each $-anchored pattern sits next to a length or character rule that rules out a trailing newline, so ECMA-262, RE2 and Python engines agree.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "recordId",
    "evidenceClass",
    "subjectIds",
    "status",
    "source",
    "environment",
    "timing",
    "expiresAt"
  ],
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "recordId": {
      "$ref": "#/$defs/recordId"
    },
    "evidenceClass": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "subjectIds": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    },
    "status": {
      "enum": [
        "passed",
        "failed",
        "blocked",
        "skipped",
        "not-applicable"
      ]
    },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "commit",
        "dirty",
        "lockfileSha256",
        "artifactHashes"
      ],
      "properties": {
        "commit": {
          "type": "string",
          "anyOf": [
            {
              "minLength": 40,
              "maxLength": 40
            },
            {
              "minLength": 64,
              "maxLength": 64
            }
          ],
          "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
        },
        "dirty": {
          "type": "boolean"
        },
        "dirtyReason": {
          "type": [
            "string",
            "null"
          ]
        },
        "lockfileSha256": {
          "oneOf": [
            {
              "$ref": "#/$defs/sha256"
            },
            {
              "type": "null"
            }
          ]
        },
        "artifactHashes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "path",
              "sha256"
            ],
            "properties": {
              "path": {
                "description": "A relative POSIX path: not empty, no leading slash, no . or .. segment, no backslash and no NUL. Paths are unique within a record.",
                "type": "string",
                "minLength": 1,
                "not": {
                  "anyOf": [
                    {
                      "pattern": "^/"
                    },
                    {
                      "pattern": String.raw`\\`
                    },
                    {
                      "pattern": String.raw`\x00`
                    },
                    {
                      "pattern": String.raw`(?:^|/)\.{1,2}/`
                    },
                    {
                      "pattern": String.raw`(?:^|/)\.{1,2}$`,
                      "not": {
                        "pattern": String.raw`\n$`
                      }
                    }
                  ]
                }
              },
              "sha256": {
                "$ref": "#/$defs/sha256"
              },
              "format": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "environment": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "os",
        "arch",
        "runtime",
        "tools"
      ],
      "properties": {
        "os": {
          "type": "string",
          "minLength": 1
        },
        "arch": {
          "type": "string",
          "minLength": 1
        },
        "runtime": {
          "type": "string",
          "minLength": 1
        },
        "tools": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "attributes": {
          "type": "object",
          "additionalProperties": {
            "type": [
              "string",
              "null"
            ]
          }
        }
      }
    },
    "timing": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "startedAt",
        "completedAt",
        "durationMs"
      ],
      "properties": {
        "startedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "completedAt": {
          "$ref": "#/$defs/dateTime"
        },
        "durationMs": {
          "type": "number",
          "minimum": 0
        }
      }
    },
    "expiresAt": {
      "$ref": "#/$defs/dateTime"
    },
    "supersedes": {
      "oneOf": [
        {
          "$ref": "#/$defs/recordId"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "$defs": {
    "recordId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "pattern": "^[A-Za-z0-9]",
      "not": {
        "pattern": "[^A-Za-z0-9._:-]"
      }
    },
    "sha256": {
      "type": "string",
      "minLength": 64,
      "maxLength": 64,
      "pattern": "^[0-9a-f]{64}$"
    },
    "dateTime": {
      "description": "An RFC 3339 date-time with a Z or numeric offset on a real proleptic Gregorian calendar day. A leap second (second 60) is accepted only where UTC inserted one: 23:59:60 UTC on a day in IANA's leap-seconds.list (tzdb 2026f, complete until 2027-06-28). The pattern lists those days at Z, +00:00 and -00:00; at any other offset it accepts second 60 in any minute, and checkEvidenceCrossValues and validateEvidenceRecord apply the offset and enforce it.",
      "type": "string",
      "pattern": String.raw`^(?:(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:0[048]|[2468][048]|[13579][26])00)-02-29)[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])|(?:1972-06-30|1972-12-31|1973-12-31|1974-12-31|1975-12-31|1976-12-31|1977-12-31|1978-12-31|1979-12-31|1981-06-30|1982-06-30|1983-06-30|1985-06-30|1987-12-31|1989-12-31|1990-12-31|1992-06-30|1993-06-30|1994-06-30|1995-12-31|1997-06-30|1998-12-31|2005-12-31|2008-12-31|2012-06-30|2015-06-30|2016-12-31)[Tt]23:59:60(?:\.[0-9]+)?(?:[Zz]|[+-]00:00)|(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:0[048]|[2468][048]|[13579][26])00)-02-29)[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:60(?:\.[0-9]+)?[+-](?:(?:0[1-9]|1[0-9]|2[0-3]):[0-5][0-9]|00:(?:0[1-9]|[1-5][0-9])))$`,
      "not": {
        "pattern": "[^-+.0-9:TZtz]"
      }
    }
  }
} as const);
