import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';
import { IconClose } from './icons';
import { cx } from './ui';

/**
 * Right-hand properties panel. Non-modal: the table behind it
 * stays usable, so clicking another row swaps the panel's contents.
 */
export function Drawer({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
}: {
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  icon?: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      aria-label={typeof title === 'string' ? title : 'Details'}
      class="fixed top-14 right-0 bottom-0 z-40 flex w-full max-w-[420px] flex-col border-l border-line bg-surface shadow-pop"
    >
      <header class="flex items-start gap-3 border-b border-line px-5 py-4">
        {icon && <div class="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted">{icon}</div>}
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-[15px] font-semibold">{title}</h2>
          {subtitle && <div class="truncate text-xs text-muted">{subtitle}</div>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" class="-mr-1 rounded p-1 text-muted hover:bg-hover hover:text-fg">
          <IconClose size={18} />
        </button>
      </header>
      <div class="flex-1 overflow-y-auto">{children}</div>
      {footer && <footer class="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
    </aside>
  );
}

/** Centered modal on a native <dialog>. Escape calls onClose unless `locked`. */
export function Modal({
  title,
  children,
  footer,
  onClose,
  locked,
  wide,
}: {
  title: ComponentChildren;
  children: ComponentChildren;
  footer?: ComponentChildren;
  onClose: () => void;
  /** Ignore Escape and hide the close button (e.g. while applying). */
  locked?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Unique per dialog: a confirmation can open on top of another dialog.
  const titleId = useId();

  useEffect(() => {
    const d = ref.current!;
    if (typeof d.showModal === 'function') {
      if (!d.open) d.showModal();
    } else {
      d.setAttribute('open', '');
    }
    return () => {
      if (typeof d.close === 'function' && d.open) d.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!locked) onClose();
      }}
      class={cx(
        'm-auto w-[calc(100%-2rem)] rounded-xl border border-line bg-surface p-0 text-fg shadow-pop',
        wide ? 'max-w-2xl' : 'max-w-md',
      )}
    >
      <header class="flex items-center justify-between gap-3 px-5 pt-5 pb-2">
        <h2 id={titleId} class="text-[15px] font-semibold">
          {title}
        </h2>
        {!locked && (
          <button type="button" onClick={onClose} aria-label="Close" class="rounded p-1 text-muted hover:bg-hover hover:text-fg">
            <IconClose size={18} />
          </button>
        )}
      </header>
      <div class="max-h-[65vh] overflow-y-auto px-5 py-2">{children}</div>
      {footer && <footer class="flex justify-end gap-2 px-5 pt-3 pb-5">{footer}</footer>}
    </dialog>
  );
}
