# Venue Vista

Venue Vista is a full-stack venue discovery MVP. Browse and search venues, create an account, save favourites, check a date, book a venue for its full listed price, and view booking history.

## Run locally

1. Install Node.js 22.13 or newer.
2. Open this folder in VS Code.
3. Copy `.env.example` to `.env`. Add Razorpay **test mode** Key ID and Key Secret to enable checkout.
4. In the VS Code terminal, run `npm start`.
5. Open <http://127.0.0.1:3000> in your browser.

No package install is needed. The server uses Node.js built-ins, including SQLite. App data is stored in `data/venue-vista.sqlite`; that folder is ignored by Git.

For auto-restart while editing, run `npm run dev` instead. Set `PORT` to choose another port. For hosting, set `HOST=0.0.0.0` and `NODE_ENV=production` behind an HTTPS reverse proxy.

## What works

- Responsive venue browsing with city/neighbourhood search and occasion filters
- Venue details and sample capacity, ratings, reviews, and full event prices
- Account creation and sign-in with salted scrypt password hashes
- HTTP-only session cookies and server-side session expiry
- Persistent favourites tied to the signed-in account
- Booking requests, venue/date availability checks, capacity validation, and request history
- Venue-owner accounts, owner-managed venue listings, and owner approval or decline of booking requests
- Full listed-price Razorpay Checkout integration with server-created orders, server-side signature and captured-payment verification, webhook signature validation, payment-state tracking, and expiring date holds
- SQLite schema setup and demo venue seeding on first run
- Basic request validation, same-origin checks, auth throttling, and safe static-file serving

## Razorpay setup

Create a Razorpay account and use **test mode** credentials for local development. Put the Key ID and Key Secret in `.env`; never put the secret in frontend code or commit `.env`. For production, configure the Razorpay webhook URL as `https://YOUR_DOMAIN/api/payments/razorpay/webhook` and subscribe to `payment.captured` and `payment.failed`. Put the webhook secret in `.env` too. The server verifies payment signatures and checks the captured payment amount and order before confirming a booking. Razorpay's official integration guide requires server-side order creation and signature verification, and its webhook guidance uses HMAC validation on the raw request body ([integration guide](https://razorpay.com/docs/server-integration/nodejs/integration-steps/), [webhook docs](https://razorpay.com/docs/webhooks/)).

Live-key payments stay disabled unless `NODE_ENV=production`, `PAYMENTS_LIVE_ENABLED=true`, and a webhook secret are configured. Enable that only after you replace demo venues and prices, publish booking/refund/privacy terms, set up HTTPS, and confirm your Razorpay account is approved. Payments go to the Razorpay merchant account configured in your dashboard; venue-owner payouts and marketplace split payments are not implemented.

## Demo data and remaining launch work

The six venues, ratings, reviews, and prices are sample content. Newly listed owner spaces are immediately visible and can accept requests; owner approval reserves a date, and checkout then charges the full listed amount. Payments go to the configured Razorpay merchant; owner payouts and split payments are not implemented. The app does not yet provide email notifications, email verification, password reset, refund administration, or per-day owner calendars. Before a public marketplace launch, replace demo content, verify venue owners and listings, add notification and payout workflows, publish final legal/refund terms, and configure production hosting, backups, and monitoring.

Photography loads from Unsplash. The server and account features work locally without third-party packages; Razorpay Checkout loads from Razorpay's hosted checkout script.
