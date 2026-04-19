import http from 'node:http';

const port = process.env.DOLLHOUSE_WEB_CONSOLE_PORT ?? '41715';

if (!/^\d+$/.test(port)) {
  console.error(`invalid DOLLHOUSE_WEB_CONSOLE_PORT: ${port}`);
  process.exit(1);
}

const numericPort = Number(port);
if (numericPort < 1 || numericPort > 65535) {
  console.error(`invalid DOLLHOUSE_WEB_CONSOLE_PORT: ${port}`);
  process.exit(1);
}

const request = http.get(
  {
    host: '127.0.0.1',
    port: numericPort,
    path: '/api/sessions',
    timeout: 5000,
  },
  (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      body += chunk;
    });
    response.on('end', () => {
      if (response.statusCode !== 200) {
        console.error(`session query failed with status ${response.statusCode ?? 'unknown'}`);
        process.exit(1);
      }

      process.stdout.write(body);
    });
  },
);

request.on('timeout', () => {
  request.destroy(new Error('session query timed out'));
});

request.on('error', (error) => {
  console.error(String(error));
  process.exit(1);
});
