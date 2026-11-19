import type { MutationResult } from "../../packages/protocol/src/index.js";

// The authoritative write already succeeded. A best-effort notification cannot
// turn that committed mutation into a business rejection.
export async function notifyCommitted(result: MutationResult, notify: () => Promise<unknown>): Promise<MutationResult> {
  try {
    await notify();
    return result;
  } catch {
    return { ...result, resyncRequired: true };
  }
}
