import { spawn } from 'node:child_process';
import { logger } from './utils/logger.js';

function runStep(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`)));
    child.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  await logger.info('Weekly agent started');
  try {
    for (const script of ['scripts/create-weekly-overview.js', 'scripts/generate-image-prompts.js', 'scripts/generate-images.js']) {
      await logger.info(`Running step: ${script}`);
      await runStep(script, args);
    }
    await logger.info('Weekly agent finished successfully');
  } catch (error) {
    await logger.error(`Weekly agent failed: ${error.message}`);
    process.exitCode = 1;
  }
}
main();
