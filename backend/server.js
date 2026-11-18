require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const Razorpay = require("razorpay");

const app = express();
const PORT = process.env.PORT || 3000;
const HOLD_MINUTES = 10;
const RESERVATION_FEE_PAISE = 100;

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL. Configure it in Render Environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined
});

const razorpayReady = Boolean(
  process.env.RAZORPAY_KEY_ID &&
  process.env.RAZORPAY_KEY_SECRET
);

const razorpay = razorpayReady
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    })
  : null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "website")));

// ==========================================
// ESP32 DEVICE AUTHENTICATION
// ==========================================

function deviceAuth(req, res, next) {
  const expected = process.env.ESP32_DEVICE_TOKEN;
  const supplied = req.get("x-device-token");

  if (!expected || !supplied || supplied !== expected) {
    return res.status(401).json({
      error: "Unauthorized device"
    });
  }

  next();
}

// ==========================================
// CUSTOMER ID VALIDATION
// ==========================================

function getCustomerId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const customerId = value.trim();

  if (
    customerId.length < 10 ||
    customerId.length > 100 ||
    !/^[a-zA-Z0-9_-]+$/.test(customerId)
  ) {
    return null;
  }

  return customerId;
}

// ==========================================
// EXPIRE UNPAID BOOKINGS
// ==========================================

async function expireUnpaidBookings(client = pool) {
  await client.query(`
    UPDATE bookings
    SET status = 'EXPIRED'
    WHERE status = 'PENDING_PAYMENT'
      AND expires_at < NOW()
  `);
}

// ==========================================
// GET PARKING SLOT STATES
// ==========================================

async function getSlotStates(client = pool) {
  await expireUnpaidBookings(client);

  const result = await client.query(`
    SELECT
      s.slot_number,
      s.occupied,

      EXISTS (
        SELECT 1
        FROM bookings b
        WHERE b.slot_number = s.slot_number
          AND b.status = 'RESERVED'
      ) AS reserved,

      EXISTS (
        SELECT 1
        FROM bookings b
        WHERE b.slot_number = s.slot_number
          AND b.status = 'PENDING_PAYMENT'
          AND b.expires_at > NOW()
      ) AS pending_payment,

      (
        SELECT b.id
        FROM bookings b
        WHERE b.slot_number = s.slot_number
          AND (
            b.status = 'RESERVED'
            OR (
              b.status = 'PENDING_PAYMENT'
              AND b.expires_at > NOW()
            )
          )
        ORDER BY
          CASE WHEN b.status = 'RESERVED' THEN 0 ELSE 1 END,
          b.created_at DESC
        LIMIT 1
      ) AS booking_id

    FROM slots s
    ORDER BY s.slot_number
  `);

  return result.rows.map(row => ({
    slot: row.slot_number,
    status: row.occupied
      ? "OCCUPIED"
      : row.reserved
        ? "RESERVED"
        : row.pending_payment
          ? "PENDING_PAYMENT"
          : "AVAILABLE",

    occupied: row.occupied,
    reserved: row.reserved,
    pendingPayment: row.pending_payment,
    bookingId: row.booking_id
  }));
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "A'Lot For Park API"
  });
});

// ==========================================
// GET PARKING SLOTS
// ==========================================

app.get("/api/slots", async (req, res) => {
  try {
    res.json({
      slots: await getSlotStates()
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not load slots"
    });
  }
});

// ==========================================
// CREATE BOOKING AND RAZORPAY ORDER
// ==========================================

app.post("/api/bookings", async (req, res) => {
  const slotNumber = Number(req.body.slot);
  const customerId = getCustomerId(req.body.customerId);

  if (![1, 2, 3, 4].includes(slotNumber)) {
    return res.status(400).json({
      error: "Choose a valid slot (1–4)"
    });
  }

  if (!customerId) {
    return res.status(400).json({
      error: "A valid customer ID is required"
    });
  }

  if (!razorpayReady) {
    return res.status(503).json({
      error: "Payments are not configured. Add Razorpay TEST keys on the backend."
    });
  }

  const client = await pool.connect();
  let bookingId;

  try {
    await client.query("BEGIN");
    await expireUnpaidBookings(client);

    const slotResult = await client.query(
      `SELECT slot_number, occupied
       FROM slots
       WHERE slot_number = $1
       FOR UPDATE`,
      [slotNumber]
    );

    if (!slotResult.rowCount) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Slot not found"
      });
    }

    if (slotResult.rows[0].occupied) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error: "This slot is already occupied."
      });
    }

    const active = await client.query(
      `SELECT id
       FROM bookings
       WHERE slot_number = $1
         AND status IN ('PENDING_PAYMENT', 'RESERVED')
         AND (
           status = 'RESERVED'
           OR expires_at > NOW()
         )
       LIMIT 1`,
      [slotNumber]
    );

    if (active.rowCount) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error: "This slot is already reserved or being booked."
      });
    }

    bookingId = crypto.randomUUID();

    const expiresAt = new Date(
      Date.now() + HOLD_MINUTES * 60 * 1000
    );

    await client.query(
      `INSERT INTO bookings
       (
         id,
         slot_number,
         status,
         amount_paise,
         expires_at,
         customer_id
       )
       VALUES ($1, $2, 'PENDING_PAYMENT', $3, $4, $5)`,
      [
        bookingId,
        slotNumber,
        RESERVATION_FEE_PAISE,
        expiresAt,
        customerId
      ]
    );

    await client.query("COMMIT");

    const order = await razorpay.orders.create({
      amount: RESERVATION_FEE_PAISE,
      currency: "INR",
      receipt: bookingId
    });

    await pool.query(
      `UPDATE bookings
       SET razorpay_order_id = $1
       WHERE id = $2`,
      [order.id, bookingId]
    );

    res.status(201).json({
      bookingId,
      slot: slotNumber,
      amount: RESERVATION_FEE_PAISE,
      currency: "INR",
      orderId: order.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      checkoutUrl: `${process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`}/checkout/${bookingId}`,
      expiresAt
    });

  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error(err);

    if (bookingId) {
      await pool.query(
        `UPDATE bookings
         SET status = 'EXPIRED'
         WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
        [bookingId]
      ).catch(() => {});
    }

    res.status(500).json({
      error: "Could not start booking/payment. Please try again."
    });

  } finally {
    client.release();
  }
});

// ==========================================
// MY BOOKINGS
// GET /api/bookings?customerId=YOUR_CUSTOMER_ID
// ==========================================

app.get("/api/bookings", async (req, res) => {
  const customerId = getCustomerId(req.query.customerId);

  if (!customerId) {
    return res.status(400).json({
      error: "A valid customer ID is required"
    });
  }

  try {
    await expireUnpaidBookings();

    const result = await pool.query(
      `SELECT
         id,
         slot_number,
         status,
         amount_paise,
         created_at,
         expires_at,
         paid_at,
         razorpay_payment_id
       FROM bookings
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customerId]
    );

    res.json({
      bookings: result.rows.map(b => ({
        id: b.id,
        slot: b.slot_number,
        status: b.status,
        amount: b.amount_paise,
        createdAt: b.created_at,
        expiresAt: b.expires_at,
        paidAt: b.paid_at,
        paymentId: b.razorpay_payment_id
      }))
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not load your bookings"
    });
  }
});

// ==========================================
// CHECK INDIVIDUAL BOOKING STATUS
// ==========================================

app.get("/api/bookings/:id", async (req, res) => {
  try {
    await expireUnpaidBookings();

    const result = await pool.query(
      `SELECT
         id,
         slot_number,
         status,
         amount_paise,
         created_at,
         expires_at,
         paid_at
       FROM bookings
       WHERE id = $1`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Booking not found"
      });
    }

    const b = result.rows[0];

    res.json({
      booking: {
        id: b.id,
        slot: b.slot_number,
        status: b.status,
        amount: b.amount_paise,
        createdAt: b.created_at,
        expiresAt: b.expires_at,
        paidAt: b.paid_at
      }
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not check booking"
    });
  }
});

// ==========================================
// VERIFY RAZORPAY PAYMENT
// ==========================================

app.post("/api/payments/verify", async (req, res) => {
  const {
    bookingId,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature
  } = req.body || {};

  if (
    !bookingId ||
    !razorpay_order_id ||
    !razorpay_payment_id ||
    !razorpay_signature
  ) {
    return res.status(400).json({
      error: "Missing payment verification fields"
    });
  }

  if (!razorpayReady) {
    return res.status(503).json({
      error: "Payment gateway is not configured"
    });
  }

  try {
    const found = await pool.query(
      "SELECT * FROM bookings WHERE id = $1",
      [bookingId]
    );

    if (!found.rowCount) {
      return res.status(404).json({
        error: "Booking not found"
      });
    }

    const booking = found.rows[0];

    if (booking.razorpay_order_id !== razorpay_order_id) {
      return res.status(400).json({
        error: "Order does not match this booking"
      });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(razorpay_signature);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return res.status(400).json({
        error: "Payment signature verification failed"
      });
    }

    const payment = await razorpay.payments.fetch(
      razorpay_payment_id
    );

    if (
      payment.order_id !== razorpay_order_id ||
      payment.status !== "captured" ||
      payment.amount !== RESERVATION_FEE_PAISE
    ) {
      return res.status(400).json({
        error: "Payment is not captured or amount/order does not match"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const locked = await client.query(
        "SELECT * FROM bookings WHERE id = $1 FOR UPDATE",
        [bookingId]
      );

      if (
        locked.rows[0].status === "RESERVED" ||
        locked.rows[0].status === "OCCUPIED"
      ) {
        await client.query("COMMIT");

        return res.json({
          ok: true,
          status: locked.rows[0].status
        });
      }

      if (locked.rows[0].status !== "PENDING_PAYMENT") {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error: "Booking hold expired. Contact the parking operator for payment assistance."
        });
      }

      await client.query(
        `UPDATE bookings
         SET status = 'RESERVED',
             razorpay_payment_id = $1,
             paid_at = NOW(),
             expires_at = NULL
         WHERE id = $2`,
        [razorpay_payment_id, bookingId]
      );

      await client.query("COMMIT");

    } finally {
      client.release();
    }

    res.json({
      ok: true,
      status: "RESERVED"
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Payment verification could not be completed"
    });
  }
});

// ==========================================
// ESP32 SENSOR UPDATE
// ==========================================

app.post("/api/esp32/status", deviceAuth, async (req, res) => {
  const slots = req.body && req.body.slots;

  if (!Array.isArray(slots) || slots.length !== 4) {
    return res.status(400).json({
      error: "Send exactly four slot sensor readings"
    });
  }

  const seen = new Set();

  for (const item of slots) {
    const slot = Number(item.slot);

    if (
      ![1, 2, 3, 4].includes(slot) ||
      typeof item.occupied !== "boolean" ||
      seen.has(slot)
    ) {
      return res.status(400).json({
        error: "Each slot needs a unique slot number 1–4 and boolean occupied value"
      });
    }

    seen.add(slot);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const item of slots) {
      const slot = Number(item.slot);
      const occupied = item.occupied;

      await client.query(
        `UPDATE slots
         SET occupied = $1,
             updated_at = NOW()
         WHERE slot_number = $2`,
        [occupied, slot]
      );

      if (occupied) {
        await client.query(
          `UPDATE bookings
           SET status = 'OCCUPIED'
           WHERE slot_number = $1
             AND status = 'RESERVED'`,
          [slot]
        );
      }
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      slots: await getSlotStates()
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);

    res.status(500).json({
      error: "Could not update sensor states"
    });

  } finally {
    client.release();
  }
});

// ==========================================
// OLED DISPLAY DATA
// ==========================================

app.get("/api/esp32/display", deviceAuth, async (req, res) => {
  try {
    res.json({
      slots: await getSlotStates(),
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not load OLED display data"
    });
  }
});

// ==========================================
// HOSTED RAZORPAY CHECKOUT
// ==========================================

app.get("/checkout/:bookingId", async (req, res) => {
  try {
    if (!razorpayReady) {
      return res.status(503).send(
        "Payment gateway is not configured."
      );
    }

    const result = await pool.query(
      "SELECT * FROM bookings WHERE id = $1",
      [req.params.bookingId]
    );

    if (!result.rowCount) {
      return res.status(404).send("Booking not found.");
    }

    const booking = result.rows[0];

    if (booking.status !== "PENDING_PAYMENT") {
      return res.send(
        "This booking is no longer awaiting payment. You can return to the A'Lot For Park app."
      );
    }

    res.type("html").send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>A'Lot For Park payment</title>
<style>
body{font-family:Arial;background:#0b1220;color:#f5f7fa;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#172638;padding:28px;border-radius:20px;max-width:360px;width:85%;text-align:center}
button{background:#42d6b0;color:#071a17;border:0;padding:14px 22px;border-radius:12px;font-weight:bold;width:100%;font-size:16px}
</style>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
</head>
<body>
<div class="card">
<h2>A'Lot For Park</h2>
<p>Parking slot ${booking.slot_number}</p>
<h1>₹1.00</h1>
<p>Reservation fee</p>
<button id="pay">Pay ₹1 and reserve</button>
<p id="msg"></p>
</div>

<script>
const options = {
  key: ${JSON.stringify(process.env.RAZORPAY_KEY_ID)},
  amount: 100,
  currency: "INR",
  name: "A'Lot For Park",
  description: "Parking reservation fee",
  order_id: ${JSON.stringify(booking.razorpay_order_id)},

  handler: async function(response) {
    document.getElementById("msg").textContent =
      "Verifying payment...";

    try {
      const r = await fetch("/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          bookingId: ${JSON.stringify(booking.id)},
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature
        })
      });

      const d = await r.json();

      document.getElementById("msg").textContent =
        d.ok
          ? "Payment verified. Your slot is RESERVED. You may return to the app."
          : (d.error || "Verification failed.");

    } catch (e) {
      document.getElementById("msg").textContent =
        "Could not verify payment. Please contact the parking operator.";
    }
  },

  modal: {
    ondismiss: function() {
      document.getElementById("msg").textContent =
        "Checkout closed. Your temporary hold may expire.";
    }
  }
};

document.getElementById("pay").onclick = () => {
  new Razorpay(options).open();
};
</script>
</body>
</html>`);

  } catch (err) {
    console.error(err);

    res.status(500).send("Could not open checkout.");
  }
});

// ==========================================
// WEBSITE FALLBACK
// ==========================================

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "..", "website", "index.html")
  );
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
  console.log(`A'Lot For Park API running on port ${PORT}`);
});
