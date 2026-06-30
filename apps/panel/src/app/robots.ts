import type { MetadataRoute } from 'next';

// The panel is an authenticated operator app, not a public site — keep crawlers
// out entirely. (Per-page noindex is also set in the root layout metadata.)
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', disallow: '/' },
  };
}
