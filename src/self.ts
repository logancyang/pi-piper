import { fileURLToPath } from 'node:url';

// Re-invoke this CLI the same way it is running: compiled JS from dist/, or TypeScript from src/ via tsx in a checkout.
const fromSource = import.meta.url.endsWith('.ts');
const cli = fileURLToPath(new URL(fromSource ? './main.ts' : './main.js', import.meta.url));
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
export const cliArgs = (...args: string[]) => [...(fromSource ? ['--import', loader] : []), cli, ...args];
