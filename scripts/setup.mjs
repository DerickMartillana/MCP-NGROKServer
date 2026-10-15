// One-time setup helper: creates .env with a random auth token if none exists.
import fs from 'node:fs';
import crypto from 'node:crypto';

if (fs.existsSync('.env')) {
  console.log('.env already exists - leaving it untouched.');
} else {
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync('.env', `MCP_AUTH_TOKEN=${token}\nPORT=3000\nHOST=127.0.0.1\n`);
  console.log('Created .env with a new random MCP_AUTH_TOKEN.');
}
console.log('Next: npm run build && npm run pm2:start');
