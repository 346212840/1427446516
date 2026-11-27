/* Shared one-time setup that survives a cancelled request.

   Several modules keep one setup promise per isolate (CREATE TABLE IF NOT
   EXISTS and similar) so only the first request pays for it. A promise
   belongs to the request that created it. When that request ends before
   the promise settles (the client hung up, or a reload aborted the fetch),
   the runtime cancels it, and every later request that awaits it fails
   with "This promise was created by a request that has since ended". The
   cached promise never settles, so its own .catch reset never runs and the
   isolate answers 500 until Cloudflare retires it.

   awaitShared() awaits the cached promise; on that error it drops the
   cache and runs the setup again inside the current request. */

const ORPHANED = /promise was created by a request that has since ended|can never settle|Cannot perform I\/O on behalf of a different request/i;

export function orphanedPromise(err) {
  return ORPHANED.test(String((err && err.message) || err || ""));
}

/* get() returns the cached promise (creating it when empty); reset()
   empties the cache. One retry: a second failure is a real error. */
export async function awaitShared(get, reset) {
  try {
    return await get();
  } catch (err) {
    if (!orphanedPromise(err)) throw err;
    reset();
    return await get();
  }
}
