const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Razorpay = require("razorpay");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use((req, res, next) => {
  if (req.originalUrl === "/api/razorpay-webhook") {
    next();
    return;
  }
  express.json()(req, res, next);
});
app.use(express.static(path.join(__dirname)));

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
const otpDemoMode = String(process.env.OTP_DEMO_MODE || "true").toLowerCase() === "true";

function isValidCredential(value) {
  if (!value || typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("your_key") || normalized.includes("your_webhook") || normalized.includes("replace")) {
    return false;
  }
  return true;
}

function hasValidRazorpayCredentials() {
  return isValidCredential(keyId) && isValidCredential(keySecret);
}

const ordersStore = new Map();
const otpStore = new Map();
const authSessions = new Map();

if (!hasValidRazorpayCredentials()) {
  console.warn("[WARN] Razorpay env vars missing. Update .env before running real payments.");
}

const razorpay = new Razorpay({
  key_id: keyId || "",
  key_secret: keySecret || ""
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "Server running" });
});

app.get("/api/config-status", (_req, res) => {
  const configured = hasValidRazorpayCredentials();
  return res.status(200).json({
    configured,
    message: configured
      ? "Razorpay credentials look configured"
      : "Razorpay credentials are missing/placeholder in .env"
  });
});

app.post("/api/auth/send-otp", (req, res) => {
  try {
    const mobile = String(req.body?.mobile || "").trim();
    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({
        ok: false,
        message: "Enter valid 10-digit mobile number"
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(mobile, {
      otp,
      expiresAt: Date.now() + 5 * 60 * 1000,
      attempts: 0
    });

    console.log(`[OTP] ${mobile} -> ${otp}`);

    return res.status(200).json({
      ok: true,
      message: "OTP sent successfully",
      ...(otpDemoMode ? { demoOtp: otp } : {})
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Failed to send OTP",
      error: error?.message || "Unknown error"
    });
  }
});

app.post("/api/auth/verify-otp", (req, res) => {
  try {
    const mobile = String(req.body?.mobile || "").trim();
    const otp = String(req.body?.otp || "").trim();

    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid mobile number"
      });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid OTP format"
      });
    }

    const record = otpStore.get(mobile);
    if (!record) {
      return res.status(400).json({
        ok: false,
        message: "OTP not requested. Please resend OTP"
      });
    }

    if (Date.now() > record.expiresAt) {
      otpStore.delete(mobile);
      return res.status(400).json({
        ok: false,
        message: "OTP expired. Please resend OTP"
      });
    }

    if (record.attempts >= 5) {
      otpStore.delete(mobile);
      return res.status(429).json({
        ok: false,
        message: "Too many attempts. Please resend OTP"
      });
    }

    record.attempts += 1;
    otpStore.set(mobile, record);

    if (record.otp !== otp) {
      return res.status(400).json({
        ok: false,
        message: "Incorrect OTP"
      });
    }

    otpStore.delete(mobile);
    const token = crypto.randomBytes(24).toString("hex");
    authSessions.set(token, {
      mobile,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });

    return res.status(200).json({
      ok: true,
      message: "Login successful",
      token,
      mobile
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "OTP verification failed",
      error: error?.message || "Unknown error"
    });
  }
});

app.post("/api/create-order", async (req, res) => {
  try {
    const amount = Number(req.body?.amount);

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    if (!hasValidRazorpayCredentials()) {
      return res.status(500).json({
        message: "Razorpay credentials are missing/placeholder in .env. Add real RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
      });
    }

    const options = {
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      notes: {
        source: "demo-online-qr-code"
      }
    };

    const order = await razorpay.orders.create(options);

    ordersStore.set(order.id, {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      status: "created",
      paymentId: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    return res.status(201).json({
      key: keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to create order",
      error: error?.message || "Unknown error"
    });
  }
});

app.post("/api/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      amount
    } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        verified: false,
        message: "Required payment fields are missing"
      });
    }

    if (!isValidCredential(keySecret)) {
      return res.status(500).json({
        verified: false,
        message: "Razorpay key secret is missing/placeholder in .env"
      });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(body.toString())
      .digest("hex");

    const verified = expectedSignature === razorpay_signature;

    if (!verified) {
      return res.status(400).json({
        verified: false,
        message: "Invalid payment signature"
      });
    }

    const existing = ordersStore.get(razorpay_order_id);
    ordersStore.set(razorpay_order_id, {
      orderId: razorpay_order_id,
      amount: existing?.amount || Math.round(Number(amount || 0) * 100),
      currency: existing?.currency || "INR",
      status: "paid",
      paymentId: razorpay_payment_id,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now()
    });

    return res.status(200).json({
      verified: true,
      message: "Payment verified successfully",
      transaction: {
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        amount: Number(amount || 0)
      }
    });
  } catch (error) {
    return res.status(500).json({
      verified: false,
      message: "Payment verification failed",
      error: error?.message || "Unknown error"
    });
  }
});

app.get("/api/payment-status/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        status: "unknown",
        message: "orderId is required"
      });
    }

    if (!hasValidRazorpayCredentials()) {
      return res.status(500).json({
        status: "unknown",
        message: "Razorpay credentials are missing/placeholder in .env"
      });
    }

    const order = await razorpay.orders.fetch(orderId);
    const paymentsResponse = await razorpay.orders.fetchPayments(orderId);
    const payments = paymentsResponse?.items || [];

    const capturedPayment = payments.find((p) => p.status === "captured");
    const authorizedPayment = payments.find((p) => p.status === "authorized");
    const failedPayment = payments.find((p) => p.status === "failed");

    let status = "pending";
    let paymentId = null;

    if (capturedPayment) {
      status = "paid";
      paymentId = capturedPayment.id;
    } else if (authorizedPayment) {
      status = "authorized";
      paymentId = authorizedPayment.id;
    } else if (failedPayment) {
      status = "failed";
      paymentId = failedPayment.id;
    }

    const existing = ordersStore.get(orderId);
    ordersStore.set(orderId, {
      orderId,
      amount: order.amount,
      currency: order.currency,
      status,
      paymentId,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now()
    });

    return res.status(200).json({
      orderId,
      amount: order.amount,
      currency: order.currency,
      status,
      paymentId,
      paymentsCount: payments.length,
      orderState: order.status
    });
  } catch (error) {
    return res.status(500).json({
      status: "unknown",
      message: "Failed to fetch payment status",
      error: error?.message || "Unknown error"
    });
  }
});

app.post("/api/razorpay-webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    if (!webhookSecret) {
      return res.status(400).json({ ok: false, message: "Webhook secret is not configured" });
    }

    const signature = req.headers["x-razorpay-signature"];
    if (!signature) {
      return res.status(400).json({ ok: false, message: "Missing webhook signature" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(req.body)
      .digest("hex");

    if (signature !== expectedSignature) {
      return res.status(400).json({ ok: false, message: "Invalid webhook signature" });
    }

    const payload = JSON.parse(req.body.toString("utf8"));
    const payment = payload?.payload?.payment?.entity;
    const orderEntity = payload?.payload?.order?.entity;

    if (orderEntity?.id) {
      const normalizedStatus = payment?.status === "captured"
        ? "paid"
        : payment?.status === "failed"
          ? "failed"
          : "pending";

      const existing = ordersStore.get(orderEntity.id);
      ordersStore.set(orderEntity.id, {
        orderId: orderEntity.id,
        amount: orderEntity.amount || existing?.amount || 0,
        currency: orderEntity.currency || existing?.currency || "INR",
        status: normalizedStatus,
        paymentId: payment?.id || existing?.paymentId || null,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || "Webhook processing failed" });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
