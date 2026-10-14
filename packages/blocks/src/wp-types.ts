/**
 * Types for `@wordpress/blocks`. The package ships declarations in build-types/
 * but its "exports" map has no "types" condition, so TypeScript can't find them
 * by package name under NodeNext. Import them by path (type-only: erased at
 * runtime). Don't use tsconfig "paths" for this: tsx applies those at runtime.
 */
export type * from '../node_modules/@wordpress/blocks/build-types/index.js';
export type WPBlocks = typeof import('../node_modules/@wordpress/blocks/build-types/index.js');
