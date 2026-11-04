-- Owner of the copy (the copy step creates the database). Like
-- production's app role: it owns its database and may install trusted
-- extensions there (pg_trgm), and it is not a superuser, so a migration
-- that needs more than production's role has fails here too. The password
-- only ever works on 127.0.0.1 inside the pod.
CREATE ROLE stockpile LOGIN PASSWORD 'rehearsal';

-- The online store's public api, for the steps that boot the candidate as
-- API_MODE=public. It holds only what the applier grants it, and it has no
-- password: pg_hba.conf admits it from 127.0.0.1 only, so no secret to keep.
CREATE ROLE storefront_public LOGIN NOINHERIT CONNECTION LIMIT 8;
