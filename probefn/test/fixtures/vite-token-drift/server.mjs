import http from 'node:http';

const args = process.argv.slice(2);
const getFlag = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(getFlag('--port') ?? '4192');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Token Drift Fixture</title>
    <style>
      body {
        font-family: sans-serif;
        margin: 24px;
        background: #ffffff;
      }

      main {
        display: grid;
        gap: 24px;
        max-width: 720px;
      }

      #primary-cta {
        width: 180px;
        height: 48px;
        border: none;
        color: white;
        background: #1B5FFF;
      }

      #primary-cta:focus,
      #primary-cta:focus-visible {
        outline: none;
        box-shadow: none;
      }

      #compact-action {
        width: 32px;
        height: 32px;
        padding: 0;
      }

      #contrast-note {
        color: rgb(122, 122, 122);
        background: rgb(130, 130, 130);
        padding: 8px 12px;
        width: fit-content;
      }
    </style>
  </head>
  <body>
    <main>
      <button id="primary-cta" type="button" aria-label="CTA">Primary CTA</button>
      <button id="compact-action" type="button" aria-label="Compact action">+</button>
      <p id="contrast-note">Muted metadata</p>
    </main>
  </body>
</html>`;

const server = http.createServer((_request, response) => {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('  VITE v5.0.0  ready in 8 ms\n');
  process.stdout.write(`  ➜  Local:   http://127.0.0.1:${port}/\n`);
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
