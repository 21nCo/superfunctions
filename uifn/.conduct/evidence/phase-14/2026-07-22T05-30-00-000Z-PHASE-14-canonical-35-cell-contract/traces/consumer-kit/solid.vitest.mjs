import solid from 'vite-plugin-solid';
export default { plugins: [solid({ hot: false })], resolve: { conditions: ['solid', 'browser', 'import'] }, test: { environment: 'jsdom', include: ['solid.test.tsx'] } };
