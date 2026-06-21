import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readTextFile(filePath) {
  return readFile(filePath, 'utf8');
}

export async function readJsonFile(filePath) {
  return JSON.parse(await readTextFile(filePath));
}

export async function writeJsonFile(filePath, data) {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function writeBinaryFile(filePath, data) {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, data);
}

export async function fileExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}
