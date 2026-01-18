import { DocPage, Sidebar, SidebarItem } from './types';

export function buildAutoSidebar(pages: DocPage[]): Sidebar {
  const root: SidebarItem[] = [];
  const map: Record<string, SidebarItem[]> = { '': root };

  // Sort pages by path/slug
  const sorted = [...pages].sort((a, b) => a.slug.localeCompare(b.slug));

  for (const page of sorted) {
    const parts = page.slug.split('/');
    const segments = parts.slice(0, -1);
    const leaf = parts[parts.length - 1];

    let currentPath = '';
    let currentLevel = root;

    // Create groups for directories
    for (const segment of segments) {
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;

      if (!map[currentPath]) {
        const group: SidebarItem = {
          type: 'group',
          text: segment.charAt(0).toUpperCase() + segment.slice(1), // simple title case
          items: [],
          collapsed: false
        };
        map[currentPath] = group.items!;
        
        // Find parent list to push this group to
        const parentList = map[parentPath] || root;
        parentList.push(group);
      }
      currentLevel = map[currentPath];
    }

    // Add page link
    currentLevel.push({
      type: 'link',
      text: page.title,
      link: page.path
    });
  }

  return {
    id: 'default',
    items: root
  };
}
