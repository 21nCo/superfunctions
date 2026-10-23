import http from 'node:http';

const args = process.argv.slice(2);
const getFlag = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(getFlag('--port') ?? '4185');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Overlay Fixture</title>
    <style>
      body {
        font-family: sans-serif;
        margin: 0;
        padding: 32px;
      }

      main {
        display: grid;
        gap: 32px;
        max-width: 960px;
        margin: 0 auto;
      }

      .stage {
        position: relative;
        min-height: 320px;
        border: 1px solid #bbb;
        padding: 24px;
        display: grid;
        place-items: center;
      }

      .checkout-primary {
        font: inherit;
        padding: 18px 28px;
      }

      .checkout-secondary {
        justify-self: end;
        font: inherit;
        padding: 12px 20px;
      }

      .overlay {
        position: absolute;
        inset: 110px 180px 110px 180px;
        background: rgba(255, 255, 255, 0.01);
        z-index: 10;
        pointer-events: auto;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Overlay Fixture</h1>
      <div class="stage">
        <button id="checkout-primary" class="checkout-primary" type="button">Checkout</button>
        <div class="overlay" aria-hidden="true"></div>
      </div>
      <button id="checkout-secondary" class="checkout-secondary" type="button">Checkout</button>
    </main>
  </body>
</html>`;

const server = http.createServer((_request, response) => {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('  VITE v5.0.0  ready in 9 ms\n');
  process.stdout.write(`  ➜  Local:   http://127.0.0.1:${port}/\n`);
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
