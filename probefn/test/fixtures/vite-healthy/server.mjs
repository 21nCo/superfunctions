import http from 'node:http';

const args = process.argv.slice(2);
const getFlag = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(getFlag('--port') ?? '4173');
const emitHmr = args.includes('--emit-hmr');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Healthy Fixture</title>
    <style>
      body {
        font-family: sans-serif;
        margin: 24px;
      }

      main {
        max-width: 640px;
        display: grid;
        gap: 16px;
      }

      label {
        display: grid;
        gap: 8px;
      }

      button,
      input,
      select {
        font: inherit;
        min-height: 44px;
        padding: 10px 14px;
      }

      [data-testid="hover-card"] {
        padding: 12px;
        border: 1px solid #999;
        min-height: 44px;
        display: grid;
        align-items: center;
      }

      button:focus,
      button:focus-visible,
      input:focus,
      input:focus-visible,
      select:focus,
      select:focus-visible,
      [data-testid="hover-card"]:focus,
      [data-testid="hover-card"]:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px #0a66ff;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Healthy Fixture</h1>
      <p id="status">idle</p>
      <label>
        Project name
        <input id="project-name" name="project-name" type="text" value="" />
      </label>
      <label>
        Plan
        <select id="plan">
          <option value="free">Free</option>
          <option value="pro">Pro</option>
        </select>
      </label>
      <button id="save-button" type="button">Save</button>
      <button id="disabled-save-button" type="button" disabled>Disabled Save</button>
      <div data-testid="hover-card" role="button" tabindex="0">Hover card</div>
    </main>
    <script>
      const status = document.getElementById('status');
      const state = {
        clicked: 0,
        hovered: 0,
        lastKey: null,
        projectName: '',
        plan: 'free'
      };

      window.__probefnFixtureState = state;

      document.getElementById('save-button').addEventListener('click', () => {
        state.clicked += 1;
        status.textContent = 'saved';
      });

      document.getElementById('project-name').addEventListener('input', (event) => {
        state.projectName = event.target.value;
      });

      document.getElementById('project-name').addEventListener('keydown', (event) => {
        state.lastKey = event.key;
      });

      document.getElementById('plan').addEventListener('change', (event) => {
        state.plan = event.target.value;
      });

      document.querySelector('[data-testid="hover-card"]').addEventListener('mouseenter', () => {
        state.hovered += 1;
      });
    </script>
  </body>
</html>`;

const server = http.createServer((_request, response) => {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('  VITE v5.0.0  ready in 12 ms\n');
  process.stdout.write(`  ➜  Local:   http://127.0.0.1:${server.address().port}/\n`);

  if (emitHmr) {
    setTimeout(() => {
      process.stdout.write('hmr update /src/main.tsx\n');
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
