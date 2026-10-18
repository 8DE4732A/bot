/**
 * Minimal Bun FFI typings (project typecheck only includes @types/node).
 * Runtime is provided by Bun; this declaration covers the few symbols we use.
 */
declare module "bun:ffi" {
  export const FFIType: {
    i32: number;
    cstring: number;
  };
  export function dlopen(
    path: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ): { symbols: Record<string, (...args: any[]) => any> };
}
