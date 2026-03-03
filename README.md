# Real-like Payment QR + Gateway Demo

This project includes:

- UPI QR payment UI
- Razorpay checkout integration
- Backend order creation API
- Backend payment signature verification API
- Live payment status polling API
- Optional Razorpay webhook endpoint

## Setup

1. Install dependencies:
   - `npm install`
2. Update `.env` with your Razorpay keys.
   - `RAZORPAY_KEY_ID`
   - `RAZORPAY_KEY_SECRET`
   - `RAZORPAY_WEBHOOK_SECRET` (optional, for webhook)
3. Start server:
   - `npm start`
4. Open in browser:
   - `http://localhost:3000`

> Current UI is locked to **₹1** (fixed amount).

## APIs

- `POST /api/create-order`
  - body: `{ "amount": 1 }`
- `POST /api/verify-payment`
  - body: `{ "razorpay_order_id", "razorpay_payment_id", "razorpay_signature", "amount" }`
- `GET /api/payment-status/:orderId`
  - returns: pending / authorized / paid / failed
- `POST /api/razorpay-webhook`
  - Razorpay webhook receiver (signature validated)

## Security Note

For production:

- always create orders on backend
- always verify signature on backend
- store successful payments in database
- use HTTPS and webhook verification
- configure webhook in Razorpay dashboard to point to `/api/razorpay-webhook`
