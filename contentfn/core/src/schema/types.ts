/**
 * ContentFn schema and document types (SPEC.md).
 */

export type ContentfnPrimitiveType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "json";

export type ContentfnFieldType =
  | { kind: "primitive"; type: ContentfnPrimitiveType }
  | { kind: "object"; fields: ContentfnField[] }
  | {
      kind: "array";
      of: Array<ContentfnFieldType | { kind: "reference"; to: string[] }>;
      maxLength?: number;
    }
  | { kind: "reference"; to: string[]; weak?: boolean }
  | {
      kind: "richtext";
      of?: "block";
      allowMarks?: string[];
      allowObjects?: string[];
    }
  | {
      kind: "markdown";
      dialect?: "commonmark" | "gfm";
      allowRawHtml?: boolean;
      extensions?: string[];
      schemaVersion?: number;
    }
  | { kind: "asset"; assetType: "file" | "image" };

export interface ContentfnField {
  name: string;
  type: ContentfnFieldType;
  required?: boolean;
  validation?: Array<
    | { rule: "min"; value: number }
    | { rule: "max"; value: number }
    | { rule: "regex"; value: string }
    | { rule: "enum"; value: string[] }
    | { rule: "unique" }
  >;
}

export interface ContentfnDocumentType {
  name: string;
  fields: ContentfnField[];
  meta?: Record<string, unknown>;
}

export interface ContentfnSchema {
  version: number;
  documentTypes: ContentfnDocumentType[];
}

export interface ContentfnSystemFields {
  _id: string;
  _type: string;
  _rev: string;
  _createdAt: string;
  _updatedAt: string;
  _publishedAt?: string;
}

export type ContentfnDocument = ContentfnSystemFields & Record<string, unknown>;
