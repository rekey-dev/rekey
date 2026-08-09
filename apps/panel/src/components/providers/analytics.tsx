import Script from 'next/script';

// Google Analytics (gtag.js) for the operator panel. Mounts only in production,
// and only when NEXT_PUBLIC_GA_MEASUREMENT_ID is set — there is deliberately no
// default. It used to default to Rekey's own measurement id (shared with the
// marketing site, for a marketing→panel funnel), which meant every self-hosted
// panel reported its operators to us with nobody opting in.
//
// Rekey Cloud sets the id as a build arg in docker-compose.panel.yml; if you
// want the cross-domain funnel, set the same id for both apps and enable it in
// the GA4 UI (Admin → Data Streams → Configure your domains).
//
// Custom events fire via track() / <TrackFlag/> / <TrackView/>. SPA pageviews
// come free from GA4 Enhanced Measurement (history-based) — no manual wiring.
// No default measurement id, deliberately. A hardcoded fallback meant every
// self-hosted panel shipped its operators' behaviour to Rekey's own GA
// property with nobody opting in. Unset => no analytics at all.
const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

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
          // page_location is pinned to the PATH, never location.href.
          // GA4 otherwise reports the full URL including the query string, and
          // this console has token-bearing routes under the root layout:
          // reset-password?token=, accept-invite, mfa-verify?challenge=.
          // Those were being transmitted to a third party, where anyone with
          // property read access could filter for them and replay an
          // unconsumed operator-reset or invite token.
          gtag('config', '${GA_ID}', {
            page_location: window.location.origin + window.location.pathname,
          });
        `}
      </Script>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="afterInteractive"
      />
    </>
  );
}
