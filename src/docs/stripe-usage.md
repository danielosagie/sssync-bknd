Stripe integration

Env variables required:
- STRIPE_SECRET_KEY=sk_live_xxx
- BILLING_RETURN_URL=https://app.sssync.app

API endpoints:
- POST /billing/portal -> returns { url } for Stripe customer portal (requires Supabase auth)

Future:
- Add per-scan usage charges when over limit via Stripe metered billing or per-request charge (e.g., $0.20/scan).
- Use existing AiUsageTrackerService to compute overages and enqueue Stripe invoice items.



