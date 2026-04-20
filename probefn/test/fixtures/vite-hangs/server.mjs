setInterval(() => {
  process.stdout.write('warming up dev server...\n');
}, 100);

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  process.exit(0);
});
