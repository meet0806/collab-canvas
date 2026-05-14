import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'crates/canvas-wasm/target/wasm32-unknown-unknown/release/canvas_wasm.wasm');
const destination = resolve(root, 'public/wasm/canvas_wasm.wasm');

statSync(source);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);

console.log(`copied ${source} -> ${destination}`);
