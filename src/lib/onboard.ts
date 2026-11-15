// Remembers (in this browser only) which getting-started steps were done.
const KEY = "investment.onboard.";

export function mark(step: string) {
  try {
    localStorage.setItem(KEY + step, "1");
  } catch { /* ignore */ }
}
export function has(step: string): boolean {
  try {
    return localStorage.getItem(KEY + step) === "1";
  } catch {
    return false;
  }
}
