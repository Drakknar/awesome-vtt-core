/**
 * Part of awesome-vtt-core, shared by awesome-vtt and awesome-vtt-mobile.
 * Keep the screen on with the Screen Wake Lock API (needs HTTPS). Browsers drop the lock when the page is hidden,
 * so it is requested again whenever the page becomes visible, and on the next tap if a request was refused.
 */
let wanted = false;
let sentinel = null;

export const wakeLockSupported = () => ("wakeLock" in navigator) && window.isSecureContext;

/**
 * Keep the screen on, or let it turn off.
 * @param {boolean} on
 */
export function setKeepAwake(on) {
  wanted = !!on;
  if ( wanted ) acquire();
  else release();
}

/**
 * Request the wake lock when it is wanted, the page is visible and none is held.
 */
async function acquire() {
  if ( !wanted || sentinel || (document.visibilityState !== "visible") || !wakeLockSupported() ) return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => sentinel = null);
  } catch {
    // Some browsers only allow it after a user gesture: try again on the next tap or click.
    document.addEventListener("pointerdown", acquire, { once: true });
  }
}

/**
 * Let go of the wake lock.
 */
function release() {
  sentinel?.release().catch(() => {});
  sentinel = null;
}

document.addEventListener("visibilitychange", acquire);
