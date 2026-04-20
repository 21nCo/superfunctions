import http from 'node:http';

const args = process.argv.slice(2);
const getFlag = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(getFlag('--port') ?? '4179');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Secret Leak Fixture</title>
  </head>
  <body>
    <h1>Secret Leak Fixture</h1>
    <p>Startup logs intentionally contain secrets so Probefn can prove redaction.</p>
  </body>
</html>`;

const server = http.createServer((request, response) => {
  if (!request.url || request.url === '/') {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
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
  process.stdout.write('BOOTSTRAP_TOKEN=top-secret-demo-token\n');
  process.stderr.write('Authorization: Bearer sk_test_secretleak123\n');
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
