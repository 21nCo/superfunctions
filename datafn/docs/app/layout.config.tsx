import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const gitConfig = {
  user: '21nCo',
  repo: 'super-functions',
  branch: 'dev',
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'DataFn',
      url: '/docs',
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
