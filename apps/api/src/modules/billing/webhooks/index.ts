// Legacy per-provider webhook URLs — permanent aliases into the pipeline
// (providers have them registered; they must keep working byte-for-byte).
export { stripeWebhookRoutes } from './stripe.routes.js';
export { paypalWebhookRoutes } from './paypal.routes.js';
export { razorpayWebhookRoutes } from './razorpay.routes.js';
// Provider-module pipeline (spec: billing-provider-modules) — the generic
// route plus the shared appliers the per-provider paths delegate to. The
// bespoke dispatchers (stripe/razorpay/paypal .handler.ts) were deleted in
// P2; per-event logic lives in the modules' `translate` + apply.ts.
export { billingProviderWebhookRoutes, handleBillingProviderWebhook } from './pipeline.js';
export { applyBillingEvent } from './apply.js';
