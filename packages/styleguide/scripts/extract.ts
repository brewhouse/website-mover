/**
 * Runs the style guide extraction on a PDF and prints the result.
 *   pnpm --filter @wm/styleguide exec tsx --env-file=../../.env scripts/extract.ts <guide.pdf> [workDir]
 */
import path from 'node:path';
import { extractStyleGuide } from '../src/index.ts';

// The output holds the client's brand images, so by default it goes under the gitignored data/.
const [pdf, workDir = pdf && path.resolve(import.meta.dirname, '../../../data/styleguide', path.basename(pdf, path.extname(pdf)))] = process.argv.slice(2);
if (!pdf || !workDir) throw new Error('usage: extract.ts <guide.pdf> [workDir]');
console.log(JSON.stringify(await extractStyleGuide(pdf, workDir), null, 2));
