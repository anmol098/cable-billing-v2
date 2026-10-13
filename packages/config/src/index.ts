/**
 * Shared TypeScript presets. Packages extend one of these from their own tsconfig.json:
 *
 *   "extends": "@cb/config/tsconfig.lib.json"   // packages/*
 *   "extends": "@cb/config/tsconfig.next.json"  // apps/web
 */
export const tsconfigPresets = [
  "tsconfig.base.json",
  "tsconfig.lib.json",
  "tsconfig.next.json",
] as const;

export type TsconfigPreset = (typeof tsconfigPresets)[number];
