/** Transient git refusals while another process holds a ref or index lock (parallel lanes, a concurrent fetch). */
export const gitLockError =
  /cannot lock ref|unable to update local ref|Unable to create '[^']*\.lock'|\.lock': File exists/u;
