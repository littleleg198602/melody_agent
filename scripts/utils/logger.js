import { appendFile } from 'node:fs/promises';
import { ensureDir } from './fs.js';

const LOG_FILE = 'logs/agent.log';

async function write(level, message) {
  await ensureDir('logs');
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  await appendFile(LOG_FILE, `${line}\n`, 'utf8');
}

export const logger = {
  info: (message) => write('INFO', message),
  warn: (message) => write('WARN', message),
  error: (message) => write('ERROR', message)
};
