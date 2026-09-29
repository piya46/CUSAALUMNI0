// Plesk/Passenger loads this CommonJS entry point; the application itself uses ESM.
const { existsSync } = require('node:fs');
const { join } = require('node:path');

if (!existsSync(join(__dirname, 'server/dist/index.js')) || !existsSync(join(__dirname, 'web/dist/index.html'))) {
  console.error('CUSA SSO: missing build output. Run npm ci --include=dev and npm run build in the application root.');
  process.exit(1);
}

import('./server/dist/index.js').catch(() => {
  // Startup errors may contain database credentials or environment values.
  console.error('CUSA SSO startup failed. Check the Node.js version, build output, and environment configuration.');
  process.exit(1);
});
