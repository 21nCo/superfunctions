import { notFound } from "next/navigation";
import { loadDocsSiteSource } from "@/source.config";

type EmbeddedPageParams = {
  slug?: string[];
};

export async function generateStaticParams() {
  const source = await loadDocsSiteSource();
  return Object.values(source.manifest.embedded?.pages ?? {})
    .map((entry) => {
      const suffix = entry.pageRoute
        .replace(source.manifest.embedded?.pageRoutePrefix ?? "/docs/embedded/page", "")
        .replace(/^\/+/, "");
      const segments = suffix.length > 0 ? suffix.split("/") : [];
      return {
        slug: segments,
      };
    })
    .sort((left, right) => left.slug.join("/").localeCompare(right.slug.join("/")));
}

export default async function EmbeddedPage(props: {
  params: Promise<EmbeddedPageParams>;
}) {
  const params = await props.params;
  const source = await loadDocsSiteSource();
  const requestedSlug = (params.slug ?? []).join("/");
  const normalizedSlug = requestedSlug.length > 0 ? requestedSlug : "index";

  const page = Object.values(source.manifest.pages).find((candidate) => {
    const candidateSlug = candidate.slug.length > 0 ? candidate.slug : "index";
    return candidateSlug === normalizedSlug;
  });
  if (!page) {
    notFound();
  }

  return (
    <article className="docsfn-embedded-page" data-docsfn-embedded-page="true">
      <h1>{page.title}</h1>
      {page.description ? <p>{page.description}</p> : null}
      {(page.headings ?? []).filter((heading) => heading.level > 1).length > 0 ? (
        <section>
          <h2>On this page</h2>
          <ul className="docs-example-toc">
            {(page.headings ?? [])
              .filter((heading) => heading.level > 1)
              .map((heading) => (
                <li key={heading.slug}>
                  <a href={`#${heading.slug}`}>{heading.text}</a>
                </li>
              ))}
          </ul>
        </section>
      ) : null}
      <pre className="docs-example-content">{page.body}</pre>
    </article>
  );
}
