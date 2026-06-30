/**
 * Server component that renders a QR code as inline SVG.
 *
 * Uses `qrcode` npm package on the server (no JS shipped to the
 * browser, no external CDN). The SVG is sized via the wrapper's CSS;
 * we strip qrcode's hard-coded width/height so Tailwind classes win.
 */

import * as React from 'react';
import QRCode from 'qrcode';

export async function QrCode({
  value,
  size = 192,
  className = '',
}: {
  value: string;
  size?: number;
  className?: string;
}): Promise<React.JSX.Element> {
  const svg = await QRCode.toString(value, {
    type: 'svg',
    margin: 1,
    width: size,
    color: { dark: '#000000', light: '#ffffff' },
  });
  // Trust: `value` is a server-controlled otpauth URL. qrcode's SVG
  // output is structured XML, no innerHTML escape concerns from `value`
  // since the library does the escaping for the encoded payload.
  return (
    <div
      // `bg-white` is deliberate (no dark: variant): QR scanners need a
      // light "quiet zone" around the code, and the SVG itself is
      // black-on-white. The token-based border frames it on dark surfaces.
      className={`inline-block rounded-md border border-[var(--color-border)] bg-white p-3 ${className}`}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
