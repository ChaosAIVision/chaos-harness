/** Static child program for exclusive checkout-directory allocation inside the process sandbox. */

/**
 * The child receives the configured root and destination as literal argv. Existing roots retain
 * their files; only the process that creates a root writes its self-ignoring .gitignore.
 */
export const PREPARE_DIRECTORY = `
import fs from 'node:fs/promises';
import path from 'node:path';
async function main() {
  const [root, destination] = process.argv.slice(1);
  await fs.mkdir(path.dirname(root), { recursive: true });
  let created = false;
  try {
    await fs.mkdir(root);
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST' || !(await fs.stat(root)).isDirectory()) throw error;
  }
  if (created) await fs.writeFile(path.join(root, '.gitignore'), '*\\n', { flag: 'wx' });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(destination);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
`

/**
 * Static child program that replaces one small file atomically inside the process sandbox.
 * The child receives the destination and the complete text as literal argv.
 */
export const WRITE_FILE = `
import fs from 'node:fs';
const [destination, text] = process.argv.slice(1);
const temporary = destination + '.' + process.pid + '.tmp';
try {
  fs.writeFileSync(temporary, text, { flag: 'wx' });
  fs.renameSync(temporary, destination);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`
