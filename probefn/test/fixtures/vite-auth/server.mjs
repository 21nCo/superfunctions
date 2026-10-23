import { createServer } from 'node:http';

function getFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(getFlag('--port') ?? '4261');

const server = createServer((request, response) => {
  if (!request.url || request.url === '/' || request.url.startsWith('/?')) {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Probefn Auth Fixture</title>
  </head>
  <body>
    <main>
      <h1>Auth Fixture</h1>
      <p id="status">booting</p>
    </main>
    <script>
      const cookieValue = document.cookie
        .split('; ')
        .find((entry) => entry.startsWith('session='))
        ?.split('=')[1] ?? 'missing';
      const user = localStorage.getItem('user') ?? 'guest';
      const plan = localStorage.getItem('plan') ?? 'none';
      document.getElementById('status').textContent = user + ':' + plan + ':' + cookieValue;
    </script>
  </body>
</html>`);
    return;
  }

  response.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end('Not found');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Local: http://127.0.0.1:${port}\n`);
});

const close = () => {
  server.close(() => process.exit(0));
};

process.on('SIGTERM', close);
process.on('SIGINT', close);
