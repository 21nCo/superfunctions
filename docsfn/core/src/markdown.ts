import { DocHeading } from "./types";

export function extractHeadings(markdown: string): DocHeading[] {
  const lines = markdown.split("\n");
  const headings: DocHeading[] = [];
  // Simple regex for ATX headings
  const regex = /^(#{1,6})\s+(.*)$/;

  lines.forEach((line) => {
    const match = line.match(regex);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      const slug = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      headings.push({ level, text, slug });
    }
  });

  return headings;
}
