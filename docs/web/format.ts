/** Formatting never changes the numeric keys used by the tree or cursor recorder. */
export function formatKey(key: number): string {
  return String(Number(key.toFixed(2)));
}
