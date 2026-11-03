-- Each payment's receipt and card (3 November): the address of the processor's own receipt for the charge, and the last
-- four digits of the card it was charged to, so the Account page's payment history can show both to the account that
-- paid. Never the card's number. Applied once, at boot, under the advisory lock (server/db.js).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_url text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_last4 text;
