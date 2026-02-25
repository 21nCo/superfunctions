import { defineSchema } from "@datafn/core";

const schema = defineSchema({
  resources: [
    {
      name: "todos",
      version: 1,
      idPrefix: "todo",
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        {
          name: "text",
          type: "string",
          required: true,
          minLength: 1,
          maxLength: 500,
        },
        { name: "completed", type: "boolean", required: true, default: false },
        {
          name: "priority",
          type: "number",
          required: false,
          min: 1,
          max: 5,
          default: 3,
        },
        { name: "createdAt", type: "date", required: true },
        { name: "updatedAt", type: "date", required: true },
      ],
      indices: {
        base: ["completed", "createdAt"],
      },
    },
    {
      name: "categories",
      version: 1,
      idPrefix: "cat",
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        {
          name: "name",
          type: "string",
          required: true,
          minLength: 1,
          maxLength: 100,
        },
        { name: "color", type: "string", required: true, default: "#646cff" },
        { name: "createdAt", type: "date", required: true },
      ],
      indices: {
        base: ["name"],
      },
    },
  ],
  relations: [
    {
      from: "todos",
      to: "categories",
      type: "many-many",
      relation: "tags",
      inverse: "todos",
    },
  ],
});

export default schema;