import { useState } from 'preact/hooks';
import { Button } from '../components/ui';

// Says what this is, on every screen, without covering the UI it shows off.
// index.css keeps Tailwind out of src/demo, so the production CSS stays the
// same: only utilities the app already uses work here; the rest is inline.

const CSS =
  // Top centre, in the header's empty middle: drawers and dialogs keep their buttons at the bottom.
  '.netui-demo{position:fixed;top:.6rem;left:50%;transform:translateX(-50%);z-index:60;display:flex;flex-direction:column;align-items:center;max-width:min(24rem,calc(100vw - 1.5rem))}' +
  '.netui-demo>div{margin-top:.5rem}';

const REPO = 'https://github.com/msjonker/netui';

export function DemoBadge() {
  const [open, setOpen] = useState(() => !sessionStorage.getItem('netui.demo.seen'));
  const close = () => {
    sessionStorage.setItem('netui.demo.seen', '1');
    setOpen(false);
  };

  return (
    <div class="netui-demo">
      <style>{CSS}</style>
      {open ? (
        <div class="rounded-lg border border-line bg-surface p-4 shadow-pop" style={{ fontSize: '14px' }} role="dialog" aria-label="About this demo">
          <p class="font-semibold">This is a demo</p>
          <p class="mt-2 text-muted">
            netui is running against a simulated OpenWrt router in your browser. Clients, traffic and settings are made up.
            Change anything: applying works as on a real router, and a reload starts over. Any password signs in.
          </p>
          <div class="mt-3 flex items-center justify-end gap-3">
            <a class="text-accent" href={REPO} target="_blank" rel="noopener">
              Get netui
            </a>
            <Button variant="primary" onClick={close}>
              Look around
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          class="rounded-full border border-line bg-surface px-3 py-1 text-xs shadow-pop"
          onClick={() => setOpen(true)}
          title="About this demo"
        >
          Demo
        </button>
      )}
    </div>
  );
}
