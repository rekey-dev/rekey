'use client';

/**
 * Lightweight dropdown menu, shadcn-style API without the dependency.
 *
 * Usage:
 *
 *   <DropdownMenu>
 *     <DropdownMenuTrigger>
 *       <button>Click me</button>
 *     </DropdownMenuTrigger>
 *     <DropdownMenuContent align="start">
 *       <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
 *       <DropdownMenuItem onSelect={() => switchTo('a')}>Workspace A</DropdownMenuItem>
 *       <DropdownMenuItem onSelect={() => switchTo('b')}>Workspace B</DropdownMenuItem>
 *       <DropdownMenuSeparator />
 *       <DropdownMenuItem onSelect={openModal}>+ New workspace</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 *
 * Click-outside, Escape, and trigger-toggle handled. It follows the
 * disclosure pattern (a button with `aria-expanded` showing a panel), not the
 * ARIA menu pattern: that one promises arrow-key navigation this does not
 * have. Items are plain focusable buttons.
 */

import * as React from 'react';
import Link from '@/components/Link';

interface MenuContext {
  open: boolean;
  setOpen: (v: boolean) => void;
  /** Close and put focus back on the trigger, so keyboard users keep their place. */
  close: () => void;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
}

const Ctx = React.createContext<MenuContext | null>(null);

function useMenuCtx(): MenuContext {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('DropdownMenu* must be used inside <DropdownMenu>');
  return ctx;
}

export function DropdownMenu({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const close = React.useCallback(() => {
    setOpen(false);
    (triggerRef.current?.firstElementChild as HTMLElement | null)?.focus();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent): void {
      const t = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(t) &&
        contentRef.current &&
        !contentRef.current.contains(t)
      ) {
        setOpen(false);
      }
    }
    // Capture phase, and the key is consumed: inside the mobile drawer (a
    // native <dialog>) the same Escape would otherwise close the drawer too.
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  return (
    <Ctx.Provider value={{ open, setOpen, close, triggerRef, contentRef }}>
      <div
        className="relative inline-block w-full"
        onBlur={(e) => {
          // Tabbing out closes it. A null target (a click on a non-focusable
          // spot, or Safari not focusing buttons) is left to the click handler.
          const next = e.relatedTarget as Node | null;
          if (next && !e.currentTarget.contains(next)) setOpen(false);
        }}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

export function DropdownMenuTrigger({
  children,
}: {
  children: React.ReactElement;
}): React.JSX.Element {
  const ctx = useMenuCtx();
  // Wrap the child so we can attach a ref + click handler without forcing
  // the consumer to forwardRef. The wrapper is `display: contents` so it
  // doesn't break flexbox parents.
  return (
    <span
      ref={(el) => {
        ctx.triggerRef.current = el;
      }}
      onClick={() => ctx.setOpen(!ctx.open)}
      style={{ display: 'contents' }}
    >
      {React.cloneElement(children as React.ReactElement<{ 'aria-expanded'?: boolean }>, { 'aria-expanded': ctx.open })}
    </span>
  );
}

export function DropdownMenuContent({
  children,
  align = 'start',
  sideOffset = 4,
  className = '',
}: {
  children: React.ReactNode;
  align?: 'start' | 'end';
  sideOffset?: number;
  className?: string;
}): React.JSX.Element | null {
  const ctx = useMenuCtx();
  if (!ctx.open) return null;
  const alignCls = align === 'end' ? 'right-0' : 'left-0';
  return (
    <div
      ref={ctx.contentRef}
      style={{ marginTop: sideOffset }}
      className={`absolute ${alignCls} z-50 min-w-[14rem] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-1 ${className}`}
    >
      {children}
    </div>
  );
}

export function DropdownMenuLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-2 py-1.5 text-xs font-medium text-[var(--color-faint-fg)]">
      {children}
    </div>
  );
}

export function DropdownMenuSeparator(): React.JSX.Element {
  return <div className="-mx-1 my-1 h-px bg-[var(--color-border)]" />;
}

export function DropdownMenuItem({
  children,
  onSelect,
  href,
  active = false,
  className = '',
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  /** Render as a link, so it keeps open-in-new-tab. */
  href?: string;
  active?: boolean;
  className?: string;
}): React.JSX.Element {
  const ctx = useMenuCtx();
  function handle(): void {
    onSelect?.();
    ctx.close();
  }
  const cls =
    'block w-full text-left px-2 py-1.5 text-sm rounded-sm transition-colors ' +
    (active
      ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)] font-medium'
      : 'text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]') +
    ' ' +
    className;
  if (href !== undefined) {
    return (
      <Link href={href} onClick={handle} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={handle} className={cls}>
      {children}
    </button>
  );
}
