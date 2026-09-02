-- Staff sessions can now be ended before their token expires.
--
-- Every token carries the tokenVersion it was minted with, and auth checks it
-- against the row on each request. Raising this number invalidates every token
-- already issued to that account - use it for a password reset or to sign
-- someone out immediately. Disabling the account (isActive = false) is checked
-- in the same place and does not need a bump.
ALTER TABLE "StaffUser" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
