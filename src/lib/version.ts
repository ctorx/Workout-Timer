/** Full commit SHA from the build that produced this bundle. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

/** Short display form (first 7 chars), matching GitHub's abbreviated SHAs. */
export function shortVersion(sha: string = APP_VERSION): string {
  if (!sha || sha === 'dev') return 'dev';
  return sha.slice(0, 7);
}
