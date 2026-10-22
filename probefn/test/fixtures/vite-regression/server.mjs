import http from 'node:http';

const args = process.argv.slice(2);
const getFlag = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(getFlag('--port') ?? '4210');
const variant = getFlag('--variant') ?? 'baseline';

const primaryCtaMarkup = variant === 'regression'
  ? ''
  : '<button id="primary-cta" data-testid="primary-cta" type="button">Primary CTA</button>';

const statsMarkup = variant === 'regression'
  ? `
      <div class="hero-gap" aria-hidden="true"></div>
      <aside class="hero-note">Priority path temporarily unavailable.</aside>
    `
  : `
      <p class="hero-note">Compare plans, invite teammates, and start faster.</p>
    `;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Regression Fixture</title>
    <style>
      :root {
        font-family: sans-serif;
      }

      body {
        margin: 0;
        background: #f5f6fb;
        color: #111827;
      }

      main {
        padding: 24px 20px 48px;
        display: grid;
        gap: 20px;
      }

      #hero {
        display: grid;
        gap: 18px;
        background: white;
        border: 1px solid #d7dbea;
        border-radius: 18px;
        padding: 28px 20px;
        box-shadow: 0 18px 44px rgba(17, 24, 39, 0.08);
      }

      #hero h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.1;
      }

      .hero-note {
        margin: 0;
        max-width: 24ch;
        font-size: 16px;
        line-height: 1.5;
      }

      .hero-gap {
        width: 244px;
        min-height: 104px;
        border-radius: 16px;
        background: rgba(224, 231, 255, 0.6);
      }

      #primary-cta {
        width: 244px;
        min-height: 104px;
        border: none;
        border-radius: 16px;
        background: linear-gradient(135deg, #0044cc, #0a66ff);
        color: white;
        font-size: 24px;
        font-weight: 700;
        box-shadow: 0 18px 36px rgba(10, 102, 255, 0.26);
      }

      #primary-cta:focus,
      #primary-cta:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px #0a66ff, 0 18px 36px rgba(10, 102, 255, 0.26);
      }

      #feature-grid {
        display: grid;
        gap: 14px;
      }

      .feature-card {
        background: white;
        border: 1px solid #d7dbea;
        border-radius: 16px;
        padding: 16px;
        min-height: 88px;
      }

      .feature-card h2,
      .feature-card p {
        margin: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <section id="hero">
        <h1>Home</h1>
        ${statsMarkup}
        ${primaryCtaMarkup}
      </section>

      <section id="feature-grid">
        <article class="feature-card">
          <h2>Shared workspaces</h2>
          <p>Keep product, design, and engineering aligned.</p>
        </article>
        <article class="feature-card">
          <h2>Faster approvals</h2>
          <p>Review visual changes before they ship.</p>
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
  process.stdout.write('  VITE v5.0.0  ready in 11 ms\n');
  process.stdout.write(`  ➜  Local:   http://127.0.0.1:${server.address().port}/\n`);
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
