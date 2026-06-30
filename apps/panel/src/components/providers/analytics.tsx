import Script from 'next/script';

// Google Analytics (gtag.js) for the operator panel. Mounts only in production
// so dev navigation doesn't pollute the GA4 property. Defaults to the SAME
// measurement ID as the marketing site so the marketing→panel funnel lands in
// one property (enable cross-domain in the GA4 UI: Admin → Data Streams →
// Configure your domains → add relipay.dev + panel.relipay.dev). Override
// per-deploy via NEXT_PUBLIC_GA_MEASUREMENT_ID.
//
// Custom events fire via track() / <TrackFlag/> / <TrackView/>. SPA pageviews
// come free from GA4 Enhanced Measurement (history-based) — no manual wiring.
const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || 'G-BGRR27P2GD';

export function Analytics() {
  if (process.env.NODE_ENV !== 'production' || !GA_ID) return null;

  return (
    <>
      {/* Bootstrap BEFORE hydration so window.gtag + dataLayer exist when our
          useEffect-fired events (panel_access, ?e= flags, page views) run on
          mount right after a HARD load (initial /login, the OAuth callback's
          HTTP redirect). Otherwise those events race the GA script and get
          dropped. js+config queue into dataLayer; the async lib below drains
          the queue once it loads. (Soft navs from server-action redirects
          already have gtag loaded, so they're unaffected either way.) */}
      <Script id="ga-init" strategy="beforeInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_ID}');
        `}
      </Script>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="afterInteractive"
      />
    </>
  );
}
