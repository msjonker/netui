// Noticing that the router now serves a newer netui than the page that is
// open. Upgrading the package restarts rpcd, which ends every session; a tab
// left open keeps running the old code, which may call what the new ACL no
// longer allows (and be signed out again after every sign-in). So when a
// session ends, the page compares its own entry script with the one the
// router serves now, and reloads if they differ.

const NOTICE_KEY = 'netui.updated';

/** The entry script of a built page (./assets/index-<hash>.js); null for the dev server's. */
export function entryScript(html: string): string | null {
  const m = /<script\b[^>]*\bsrc="([^"]*assets\/index-[^"]+\.js)"/.exec(html);
  return m ? m[1]! : null;
}

/** True if the router serves a different build than this page runs. */
export async function newBuildServed(doc: Document = document, fetchFn: typeof fetch = fetch, url = location.href): Promise<boolean> {
  const mine = entryScript(doc.documentElement.outerHTML);
  if (!mine) return false;
  try {
    const res = await fetchFn(new URL('./', url).href, { cache: 'no-store' });
    if (!res.ok) return false;
    const served = entryScript(await res.text());
    return !!served && served !== mine;
  } catch {
    return false;
  }
}

/** Reload into the new build, telling the sign-in page why. */
export function reloadForUpdate(): void {
  sessionStorage.setItem(NOTICE_KEY, '1');
  location.reload();
}

/** After a reload for an update: the notice to show once. */
export function takeUpdateNotice(): string | null {
  if (!sessionStorage.getItem(NOTICE_KEY)) return null;
  sessionStorage.removeItem(NOTICE_KEY);
  return 'netui was updated on the router. Sign in again.';
}
