'use client';

/**
 * Lightweight dropdown menu — shadcn-style API without the dependency.
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
 * Click-outside, Escape, and trigger-toggle handled. Items render as
 * focusable buttons; arrow-key navigation is intentionally *not* wired to
 * keep this small — for menus longer than ~6 items we'd swap in Radix.
 */

import * as React from 'react';

interface MenuContext {
  open: boolean;
  setOpen: (v: boolean) => void;
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
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <Ctx.Provider value={{ open, setOpen, triggerRef, contentRef }}>
      <div className="relative inline-block w-full">{children}</div>
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
      {children}
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
      role="menu"
      style={{ marginTop: sideOffset }}
      className={`absolute ${alignCls} z-50 min-w-[14rem] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-1 ${className}`}
    >
      {children}
    </div>
  );
}

export function DropdownMenuLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-[var(--color-faint-fg)]">
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
  active = false,
  className = '',
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  active?: boolean;
  className?: string;
}): React.JSX.Element {
  const ctx = useMenuCtx();
  function handle(): void {
    onSelect?.();
    ctx.setOpen(false);
  }
  return (
    <button
      type="button"
      role="menuitem"
      onClick={handle}
      className={
        'block w-full text-left px-2 py-1.5 text-sm rounded-sm transition-colors ' +
        (active
          ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)] font-medium'
          : 'text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]') +
        ' ' +
        className
      }
    >
      {children}
    </button>
  );
}
