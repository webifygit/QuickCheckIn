-- Aadhaar numbers must never sit in the database in full. Numbers read from a
-- card's QR were always masked, but a number typed into the guest form or
-- corrected by staff was stored verbatim, so existing rows have to be brought
-- in line with what the schema, the UI and the privacy notice all claim.
--
-- Irreversible by design: there is no down migration, because recovering the
-- digits this discards is exactly what must not be possible.

UPDATE "Registration"
SET "idNumber" = 'XXXX XXXX ' || right(regexp_replace("idNumber", '[^0-9]', '', 'g'), 4)
WHERE "idType" = 'AADHAAR'
  AND "idNumber" IS NOT NULL
  AND "idNumber" !~ '^XXXX XXXX [0-9]{4}$'
  AND length(regexp_replace("idNumber", '[^0-9]', '', 'g')) >= 4;

-- Anything left holds fewer than four digits, so it is not an Aadhaar number and
-- cannot be masked into a meaningful last-four. Clearing it beats keeping a
-- fragment nobody can act on.
UPDATE "Registration"
SET "idNumber" = NULL
WHERE "idType" = 'AADHAAR'
  AND "idNumber" IS NOT NULL
  AND "idNumber" !~ '^XXXX XXXX [0-9]{4}$';
