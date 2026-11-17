CREATE TABLE IF NOT EXISTS slots (
  slot_number INTEGER PRIMARY KEY CHECK (slot_number BETWEEN 1 AND 4),
  occupied BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO slots (slot_number, occupied)
VALUES (1, FALSE), (2, FALSE), (3, FALSE), (4, FALSE)
ON CONFLICT (slot_number) DO NOTHING;

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY,
  slot_number INTEGER NOT NULL REFERENCES slots(slot_number),
  status TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'RESERVED', 'OCCUPIED', 'EXPIRED', 'CANCELLED')),
  amount_paise INTEGER NOT NULL DEFAULT 100,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bookings_slot_status_idx ON bookings(slot_number, status);
CREATE INDEX IF NOT EXISTS bookings_expiry_idx ON bookings(expires_at);
