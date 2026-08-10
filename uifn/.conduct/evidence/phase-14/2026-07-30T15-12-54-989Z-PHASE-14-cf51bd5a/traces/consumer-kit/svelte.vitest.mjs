import { svelte } from '@sveltejs/vite-plugin-svelte';
export default { plugins: [svelte()], resolve: { conditions: ['browser'] }, test: { environment: 'jsdom', include: ['svelte.test.ts'] } };
