export type DocsGitConfig = {
  user: string;
  repo: string;
  branch: string;
};

export type DocsBaseLayoutProps = {
  nav?: {
    title?: string;
    url?: string;
  };
  githubUrl?: string;
  [key: string]: unknown;
};

export function createBaseLayoutOptions(
  title: string,
  gitConfig: DocsGitConfig,
  docsUrl = "/docs",
): DocsBaseLayoutProps {
  return {
    nav: {
      title,
      url: docsUrl,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
