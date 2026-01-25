import type { DocPage, Sidebar, SidebarItem } from "./types";

export interface BreadcrumbItem {
  label: string;
  href: string;
}

/**
 * Generate breadcrumbs from a route path
 * Example: /docs/guides/setup -> [Home, Docs, Guides, Setup]
 */
export function generateBreadcrumbs(
  path: string,
  pages: Record<string, DocPage>,
  options: {
    homeLabel?: string;
    homeHref?: string;
  } = {}
): BreadcrumbItem[] {
  const { homeLabel = "Home", homeHref = "/" } = options;

  const crumbs: BreadcrumbItem[] = [{ label: homeLabel, href: homeHref }];

  // Split path and build breadcrumbs
  const segments = path.split("/").filter(Boolean);
  let currentPath = "";

  for (let i = 0; i < segments.length; i++) {
    currentPath += `/${segments[i]}`;

    // Try to find a page with this path
    const page = Object.values(pages).find((p) => p.path === currentPath);

    if (page) {
      crumbs.push({
        label: page.title,
        href: currentPath,
      });
    } else {
      // Fallback: capitalize segment
      const label = segments[i]
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

      crumbs.push({
        label,
        href: currentPath,
      });
    }
  }

  return crumbs;
}

export interface PaginationLinks {
  prev?: {
    title: string;
    path: string;
  };
  next?: {
    title: string;
    path: string;
  };
}

/**
 * Get prev/next page links based on sidebar order
 */
export function getPaginationFromSidebar(
  currentPath: string,
  sidebar: Sidebar
): PaginationLinks {
  const links: string[] = [];

  // Flatten sidebar to get all links in order
  function flatten(items: SidebarItem[]) {
    for (const item of items) {
      if (item.type === "link" && item.link) {
        links.push(item.link);
      } else if (item.type === "group" && item.items) {
        flatten(item.items);
      }
    }
  }

  flatten(sidebar.items);

  // Find current index
  const currentIndex = links.indexOf(currentPath);

  if (currentIndex === -1) {
    return {};
  }

  const result: PaginationLinks = {};

  // Get prev
  if (currentIndex > 0) {
    result.prev = {
      path: links[currentIndex - 1],
      title: links[currentIndex - 1], // Will be replaced by actual title in component
    };
  }

  // Get next
  if (currentIndex < links.length - 1) {
    result.next = {
      path: links[currentIndex + 1],
      title: links[currentIndex + 1],
    };
  }

  return result;
}

/**
 * Enhanced version that includes actual page titles
 */
export function getPaginationFromSidebarWithTitles(
  currentPath: string,
  sidebar: Sidebar,
  pages: Record<string, DocPage>
): PaginationLinks {
  const pagination = getPaginationFromSidebar(currentPath, sidebar);

  // Find page titles
  if (pagination.prev) {
    const prevPage = Object.values(pages).find(
      (p) => p.path === pagination.prev!.path
    );
    if (prevPage) {
      pagination.prev.title = prevPage.title;
    }
  }

  if (pagination.next) {
    const nextPage = Object.values(pages).find(
      (p) => p.path === pagination.next!.path
    );
    if (nextPage) {
      pagination.next.title = nextPage.title;
    }
  }

  return pagination;
}
