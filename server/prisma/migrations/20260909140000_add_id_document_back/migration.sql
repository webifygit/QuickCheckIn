-- An Aadhaar card carries the name, photo and date of birth on the front and
-- the address on the back, and a front desk checking a guest in needs both. One
-- photo holding both sides gives each of them half the frame, which is what
-- makes a printed address unreadable at review time.
--
-- Nullable with no default, so this is additive and safe to deploy ahead of the
-- code that writes it: every existing row keeps its single front image, reads
-- return NULL for the new column, and nothing is rewritten or locked for long.
ALTER TABLE "Registration" ADD COLUMN IF NOT EXISTS "idDocumentBackKey" TEXT;
