import http from 'node:http';

const args = process.argv.slice(2);
const getFlag = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(getFlag('--port') ?? '4176');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Console Error Fixture</title>
  </head>
  <body>
    <h1>Console Error Fixture</h1>
    <button id="submit-order" type="button">Submit order</button>
    <p id="status">Ready</p>
    <script>
      window.addEventListener('load', () => {
        console.error('TypeError: Cannot read properties of undefined (reading "plan")');
        fetch('/api/fail').catch(() => undefined);
        fetch('http://127.0.0.1:9/unreachable').catch(() => undefined);
        setTimeout(() => {
          throw new Error('Fixture page exploded.');
        }, 0);

        const button = document.getElementById('submit-order');
        const status = document.getElementById('status');

        button?.addEventListener('click', async () => {
          console.error('TypeError: Cannot read properties of undefined (reading "plan")');
          status.textContent = 'Submitting';
          try {
            await fetch('/api/fail', {
              method: 'POST',
            });
          } catch (error) {
            // Ignore fixture transport errors; Probefn should capture them.
          } finally {
            status.textContent = 'Failed';
          }
        });
      });
    </script>
  </body>
</html>`;

const server = http.createServer((request, response) => {
  if (!request.url || request.url === '/') {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
    return;
  }

  if (request.url === '/api/fail') {
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'fixture failure' }));
    return;
  }

  if (request.url === '/favicon.ico') {
    response.statusCode = 204;
    response.end();
    return;
  }

  response.statusCode = 404;
  response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('  VITE v5.0.0  ready in 12 ms\n');
  process.stdout.write(`  ➜  Local:   http://127.0.0.1:${port}/\n`);
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
