-- Migration: Harden notify_activity_update() for mixed event schemas
-- Purpose:
--   Prevent trigger failures on tables that expose `signer` instead of
--   `user_address` by safely reading row fields via to_jsonb(NEW).
--
-- Safe to re-run:
--   Uses CREATE OR REPLACE FUNCTION and only updates function body.

CREATE OR REPLACE FUNCTION public.notify_activity_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_row jsonb;
  user_address_text text;
  pair_text text;
  event_timestamp_text text;
BEGIN
  -- Access NEW via JSON to avoid "record has no field" runtime errors
  -- across heterogeneous source tables.
  new_row := to_jsonb(NEW);

  user_address_text := COALESCE(
    NULLIF(new_row->>'user_address', ''),
    NULLIF(new_row->>'signer', '')
  );
  pair_text := NULLIF(new_row->>'pair', '');
  event_timestamp_text := COALESCE(
    NULLIF(new_row->>'timestamp', ''),
    NULLIF(new_row->>'event_timestamp', '')
  );

  PERFORM pg_notify(
    'activity_updates',
    json_build_object(
      'category', TG_ARGV[0],
      'table', TG_TABLE_NAME,
      'op', TG_OP,
      'user_address', user_address_text,
      'pair', pair_text,
      'event_timestamp', event_timestamp_text
    )::text
  );

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  fn_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'notify_activity_update'
  )
  INTO fn_exists;

  IF fn_exists THEN
    RAISE NOTICE 'Migration 010: notify_activity_update function is installed and hardened';
  ELSE
    RAISE EXCEPTION 'Migration 010 failed: notify_activity_update function is missing';
  END IF;
END $$;
