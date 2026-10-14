/**
 * Runs the style guide extraction on a PDF and prints the result.
 *   pnpm --filter @wm/styleguide exec tsx --env-file=../../.env scripts/extract.ts <guide.pdf> [workDir]
 */
import { extractStyleGuide } from '../src/index.ts';

const [pdf, workDir = 'style-guide-work'] = process.argv.slice(2);
if (!pdf) throw new Error('usage: extract.ts <guide.pdf> [workDir]');
console.log(JSON.stringify(await extractStyleGuide(pdf, workDir), null, 2));
