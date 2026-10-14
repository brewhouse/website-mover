/**
 * Keep only blocks the target site allows. A seed can switch block types off in
 * the editor (Planeteria seeds use "Disable Unused Block Editor Blocks"); content
 * using them would show as "not supported", so each disabled block is rebuilt
 * from allowed blocks with `createBlock`, and every substitution is reported.
 */
import type { Block } from './wp-types.js';
import { loadWordPress } from './env.js';

type Fallback = (block: Block) => Block[];

export function restrictBlocks(
  blocks: Block[],
  disabled: Iterable<string>,
  onWarning: (message: string) => void = () => {},
): Block[] {
  const off = new Set(disabled);
  if (!off.size) return blocks;
  // core/buttons stays enabled on some sites while core/button is off, which
  // leaves the container unusable: treat it as disabled too.
  if (off.has('core/button')) off.add('core/buttons');
  const wp = loadWordPress();
  const p = (content: string) => wp.createBlock('core/paragraph', { content });
  const text = (value: unknown) => String(value ?? '');

  const fallbacks: Record<string, Fallback> = {
    // Background image + content on top → the image, then the content.
    'core/cover': (b) => [
      ...(b.attributes.url ? [wp.createBlock('core/image', { url: b.attributes.url, alt: b.attributes.alt ?? '' })] : []),
      ...b.innerBlocks,
    ],
    // A button row → one link paragraph per button.
    'core/buttons': (b) => b.innerBlocks.flatMap((button) => fallbacks['core/button']!(button)),
    'core/button': (b) => [p(link(text(b.attributes.url), text(b.attributes.text)))],
    // Decorative; nothing to keep.
    'core/separator': () => [],
    'core/preformatted': (b) => [p(text(b.attributes.content).replace(/\n/g, '<br>'))],
    'core/code': (b) => [p(`<code>${text(b.attributes.content).replace(/\n/g, '<br>')}</code>`)],
    'core/embed': (b) => [p(link(text(b.attributes.url), escapeAttr(text(b.attributes.url))))],
  };

  const visit = (list: Block[]): Block[] =>
    list.flatMap((block) => {
      if (!off.has(block.name)) {
        return [wp.createBlock(block.name, block.attributes, visit(block.innerBlocks))];
      }
      const fallback = fallbacks[block.name];
      if (fallback) {
        onWarning(`${block.name} is disabled on the target; replaced with allowed blocks`);
        return visit(fallback(block));
      }
      if (!off.has('core/html')) {
        onWarning(`${block.name} is disabled on the target; kept as core/html`);
        return [wp.createBlock('core/html', { content: wp.getSaveContent(block.name, block.attributes, block.innerBlocks) })];
      }
      onWarning(`${block.name} is disabled on the target and core/html is too; dropped`);
      return [];
    });

  return visit(blocks);
}

function link(url: string, label: string): string {
  return `<a href="${escapeAttr(url)}">${label}</a>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&(?!(?:[a-z]+|#\d+|#x[\da-f]+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
