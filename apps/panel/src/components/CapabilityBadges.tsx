import * as React from 'react';
import { Badge } from '@/components/Badge';

/** Support capability names as badges, or "none" for an empty list. */
export function CapabilityBadges({ names }: { names: string[] }): React.JSX.Element {
  if (names.length === 0) return <span className="text-[var(--color-muted-fg)]">none</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {names.map((name) => (
        <Badge key={name} mono>
          {name}
        </Badge>
      ))}
    </span>
  );
}
