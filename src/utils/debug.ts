export const DEBUG_ICOM = process.env.DEBUG_ICOM === '1' || process.env.DEBUG_ICOM === 'true';
export const DEBUG_ICOM_LEVEL = Number.parseInt(process.env.DEBUG_ICOM_LEVEL || (DEBUG_ICOM ? '1' : '0'), 10) || 0;
export function dbg(...args: any[]) {
  if (DEBUG_ICOM_LEVEL >= 1) console.log('[icom]', ...args);
}
export function dbgV(...args: any[]) {
  if (DEBUG_ICOM_LEVEL >= 2) console.log('[icom]', ...args);
}
