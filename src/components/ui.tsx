import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';

// Shared presentational primitives: flat white
// cards with 1px borders, dense 13px type, blue primary actions.

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Layout

export function Page({
  title,
  actions,
  children,
  subtitle,
}: {
  title: string;
  subtitle?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <div class="flex min-h-full flex-col">
      <header class="flex min-h-14 flex-wrap items-center gap-3 px-6 pt-4 pb-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle && <p class="text-xs text-muted">{subtitle}</p>}
        </div>
        {actions && <div class="flex items-center gap-2">{actions}</div>}
      </header>
      <div class="flex-1 px-6 pb-6">{children}</div>
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  class: cls,
  flush,
}: {
  title?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
  /** No body padding, for tables. */
  flush?: boolean;
}) {
  return (
    <section class={cx('rounded-lg border border-line bg-surface', cls)}>
      {(title || actions) && (
        <header class="flex h-11 items-center justify-between gap-2 border-b border-line px-4">
          <h2 class="text-[13px] font-semibold">{title}</h2>
          {actions && <div class="flex items-center gap-2 text-xs">{actions}</div>}
        </header>
      )}
      <div class={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

/** Label/value rows, as in the device and client panels. */
export function Detail({ rows }: { rows: [ComponentChildren, ComponentChildren][] }) {
  return (
    <dl class="divide-y divide-line">
      {rows.map(([k, v], i) => (
        <div key={i} class="flex min-h-9 items-center justify-between gap-4 py-1.5">
          <dt class="shrink-0 text-muted">{k}</dt>
          <dd class="min-w-0 truncate text-right">{v ?? <span class="text-faint">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ComponentChildren; hint?: ComponentChildren }) {
  return (
    <div class="min-w-0">
      <div class="text-xs text-muted">{label}</div>
      <div class="truncate text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div class="truncate text-xs text-muted">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-fg border-line hover:border-line-strong hover:bg-hover',
  ghost: 'bg-transparent text-accent border-transparent hover:bg-accent-soft',
  danger: 'bg-surface text-bad border-line hover:border-bad hover:bg-bad-soft',
};

export function Button({
  variant = 'secondary',
  class: cls,
  children,
  ...rest
}: JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  type?: 'button' | 'submit';
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      class={cx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON[variant],
        cls as string,
      )}
    >
      {children}
    </button>
  );
}

type SwitchProps = { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean };

function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <span class="relative inline-flex shrink-0 items-center">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        class="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span class="h-5 w-9 rounded-full bg-line-strong transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-accent" />
      <span class="absolute left-0.5 size-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
    </span>
  );
}

/** Blue switch. Renders a real checkbox with role="switch" for a11y and tests. */
export function Toggle(props: SwitchProps) {
  return (
    <label class={cx('inline-flex', props.disabled ? 'opacity-50' : 'cursor-pointer')}>
      <Switch {...props} />
    </label>
  );
}

/** A labelled form row: label left, control right. */
export function Field({
  label,
  hint,
  error,
  children,
  stacked,
}: {
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string | null;
  children: (id: string) => ComponentChildren;
  stacked?: boolean;
}) {
  const id = useId();
  return (
    <div class={cx('py-2.5', stacked ? 'space-y-1.5' : 'grid grid-cols-1 gap-1.5 sm:grid-cols-[200px_1fr] sm:items-start sm:gap-4')}>
      <label for={id} class="pt-1.5 text-muted">
        {label}
      </label>
      <div class="min-w-0 space-y-1">
        {children(id)}
        {error ? (
          <p class="text-xs text-bad" role="alert">
            {error}
          </p>
        ) : (
          hint && <p class="text-xs text-muted">{hint}</p>
        )}
      </div>
    </div>
  );
}

/** A label + switch row. */
export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ComponentChildren;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  // The whole row is the label, so clicking the text flips the switch too.
  return (
    <label class={cx('flex items-start justify-between gap-4 py-2.5', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <div>
        <div>{label}</div>
        {hint && <div class="text-xs text-muted">{hint}</div>}
      </div>
      <Switch label={label} checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

export function FormSection({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="border-b border-line pb-3 last:border-0">
      <h3 class="pt-4 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** Segmented control used for table filters (All / Wired / Wireless ...). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ComponentChildren }[];
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} class="inline-flex rounded-md border border-line bg-subtle p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          class={cx(
            'h-7 rounded-[5px] px-3 text-[13px] whitespace-nowrap transition-colors',
            o.value === value ? 'bg-surface font-medium text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: string }[];
}) {
  return (
    <div role="tablist" class="flex gap-5 border-b border-line px-5">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          class={cx(
            '-mb-px h-10 border-b-2 text-[13px] transition-colors',
            t.value === value ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status

type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent';

const PILL: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  neutral: 'bg-subtle text-muted border border-line',
  accent: 'bg-accent-soft text-accent',
};

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ComponentChildren }) {
  return (
    <span class={cx('inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap', PILL[tone])}>
      {children}
    </span>
  );
}

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  neutral: 'bg-faint',
  accent: 'bg-accent',
};

export function Dot({ tone }: { tone: Tone }) {
  return <span class={cx('inline-block size-2 shrink-0 rounded-full', DOT[tone])} aria-hidden="true" />;
}

export function Banner({
  tone = 'accent',
  children,
  actions,
  role,
}: {
  tone?: Exclude<Tone, 'neutral'>;
  children: ComponentChildren;
  actions?: ComponentChildren;
  role?: 'alert' | 'status';
}) {
  const border = { ok: 'border-ok', warn: 'border-warn', bad: 'border-bad', accent: 'border-accent' }[tone];
  return (
    <div role={role} class={cx('flex items-center gap-3 rounded-md border-l-4 bg-surface px-4 py-2.5 shadow-sm', border)}>
      <div class="min-w-0 flex-1">{children}</div>
      {actions && <div class="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ class: cls }: { class?: string }) {
  return (
    <span
      class={cx('inline-block size-4 animate-spin rounded-full border-2 border-line border-t-accent', cls)}
      role="progressbar"
      aria-label="Loading"
    />
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="px-4 py-10 text-center text-muted">{children}</div>;
}

/** Thin horizontal usage bar. */
export function Meter({ value, tone = 'accent' }: { value: number; tone?: Tone }) {
  return (
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-subtle" role="meter" aria-valuenow={Math.round(value * 100)}>
      <div class={cx('h-full rounded-full', DOT[tone])} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

/** Shows a page-level load error with the original message. */
export function LoadError({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div class="mb-4">
      <Banner tone="bad" role="alert">
        Could not read from the router: {error.message}
      </Banner>
    </div>
  );
}
