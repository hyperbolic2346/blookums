-- Test role for the build pod: owns ci_test and may create databases (the
-- Stockpile suite creates its database if missing); not a superuser.
CREATE ROLE ci LOGIN CREATEDB PASSWORD 'ci';
CREATE DATABASE ci_test OWNER ci;
