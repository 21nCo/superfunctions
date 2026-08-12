
for (const name of ['document', 'window']) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(name + ' read during server import'); } });
const packages = await Promise.all(['@uifn/core', '@uifn/dom', '@uifn/adapter-kit'].map((name) => import(name)));
if (packages.some((entry) => Object.keys(entry).length === 0)) throw new Error('Empty packed package import.');
console.log(JSON.stringify({ ok: true, node: process.version, packages: ['@uifn/core', '@uifn/dom', '@uifn/adapter-kit'] }));
