// The real component moved to app/_providers/analytics.tsx: next/script's
// beforeInteractive strategy it uses is only allowed in the root layout's
// subtree, and Next's own lint rule enforces that by file path. Re-exported
// here so importers keep using this path.
export { Analytics } from '@/app/_providers/analytics';
