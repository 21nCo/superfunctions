import http from 'node:http';

const args = process.argv.slice(2);
const getFlag = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(getFlag('--port') ?? '4184');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Ambiguous Fixture</title>
    <style>
      body {
        font-family: sans-serif;
        margin: 24px;
      }

      main {
        display: grid;
        gap: 24px;
        max-width: 720px;
      }

      section {
        display: grid;
        gap: 12px;
        padding: 16px;
        border: 1px solid #bbb;
      }

      button {
        font: inherit;
        width: fit-content;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Ambiguous Fixture</h1>
      <section>
        <h2>Hero</h2>
        <button id="hero-primary-save" type="button" aria-label="Primary CTA">Save</button>
      </section>
      <section>
        <h2>Footer</h2>
        <button id="footer-primary-save" type="button" aria-label="Primary CTA">Save</button>
      </section>
    </main>
  </body>
</html>`;

const server = http.createServer((_request, response) => {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('  VITE v5.0.0  ready in 11 ms\n');
  process.stdout.write(`  ➜  Local:   http://127.0.0.1:${port}/\n`);
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
