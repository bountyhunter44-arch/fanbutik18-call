import { copyFile } from 'node:fs/promises';
await copyFile(new URL('../core.mjs', import.meta.url), new URL('../cloud/core.mjs', import.meta.url));
console.log('Cloud-kilde forberedt. Intet deployet.');
