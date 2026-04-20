import http from 'node:http';

const args = process.argv.slice(2);
const getFlag = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(getFlag('--port') ?? '4190');
const emitHmr = args.includes('--emit-hmr');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Overflow Fixture</title>
    <style>
      :root {
        font-family: sans-serif;
      }

      body {
        margin: 0;
        padding: 0;
        background: #f7f7fb;
      }

      main {
        display: grid;
        gap: 20px;
        padding: 20px 0 24px 0;
      }

      #pricing-grid {
        width: 414px;
        display: grid;
        grid-template-columns: repeat(2, 180px);
        gap: 18px;
      }

      .card {
        position: relative;
        display: grid;
        gap: 12px;
        padding: 20px;
        background: white;
        border: 1px solid #d4d4de;
      }

      #secondary-cta {
        width: 160px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: clip;
        padding: 12px 14px;
      }

      .badge {
        position: absolute;
        top: 54px;
        left: 112px;
        width: 92px;
        height: 32px;
        background: rgba(255, 221, 87, 0.96);
        border: 1px solid rgba(190, 140, 0, 0.8);
      }
    </style>
  </head>
  <body>
    <main>
      <section id="pricing-grid" data-testid="pricing-grid">
        <article class="card">
          <h2>Starter</h2>
          <p>For small teams</p>
          <button id="primary-cta" type="button">Primary CTA</button>
        </article>
        <article class="card">
          <h2>Scale</h2>
          <p>For growing teams</p>
          <button id="secondary-cta" type="button">Secondary CTA label runs long</button>
          <div class="badge" aria-hidden="true"></div>
        </article>
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
  process.stdout.write('  VITE v5.0.0  ready in 10 ms\n');
  process.stdout.write(`  ➜  Local:   http://127.0.0.1:${port}/\n`);

  if (emitHmr) {
    setTimeout(() => {
      process.stdout.write('hmr update /src/pricing.tsx\n');
    }, 100);
  }
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
