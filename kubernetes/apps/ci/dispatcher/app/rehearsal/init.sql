-- Owner of the copy (the copy step creates the database). Like
-- production's app role: it owns its database and may install trusted
-- extensions there (pg_trgm), and it is not a superuser, so a migration
-- that needs more than production's role has fails here too. The password
-- only ever works on 127.0.0.1 inside the pod.
CREATE ROLE stockpile LOGIN PASSWORD 'rehearsal';
