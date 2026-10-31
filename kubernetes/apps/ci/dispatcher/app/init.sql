-- Test role for the build pod: owns ci_test and may create databases (the
-- Stockpile suite creates its database if missing) and roles (stockpile#752's
-- storefront-role test creates the restricted public role, applies its grants
-- and runs the storefront as it); not a superuser. This Postgres is a
-- throwaway sidecar per build, so nothing outlives the pod.
CREATE ROLE ci LOGIN CREATEDB CREATEROLE PASSWORD 'ci';
CREATE DATABASE ci_test OWNER ci;
