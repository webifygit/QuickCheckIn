-- PAN is one of the commonest IDs presented at an Indian front desk, but it was
-- not in the list, so a guest holding one had to file themselves under OTHER.
--
-- Adding a value to an enum is additive and safe to deploy ahead of the code
-- that uses it: existing rows keep their value, and nothing here reads the new
-- one in the same transaction (which is what Postgres would refuse).
ALTER TYPE "IdType" ADD VALUE IF NOT EXISTS 'PAN';
