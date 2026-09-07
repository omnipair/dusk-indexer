-- Migration: stream Dusk swaps over the existing LISTEN/NOTIFY channel
-- Channel: swap_updates (the same one the v1 gRPC listener already consumes)
--
-- v1 triggers on the `swaps` TABLE. Dusk's `swaps` is a VIEW over
-- dusk_ingestion.event_stream (migration 020), and a row trigger cannot fire on
-- a view, so the trigger goes on the underlying table and reshapes the event
-- into the payload the listener already parses. Nothing in grpc/ changes.
--
-- The payload deliberately mirrors 002_add_swaps_notify_trigger.sql field for
-- field, including `op`, which the listener uses to tell a bare insert from a
-- later enriched update. Dusk inserts arrive complete, so every notification is
-- an INSERT and the listener's enrichment wait simply never has anything to
-- wait for.

CREATE OR REPLACE FUNCTION dusk_ingestion.notify_swap_executed()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.event_name <> 'SwapExecuted' OR NEW.market IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_notify(
        'swap_updates',
        json_build_object(
            'op', TG_OP,
            -- event_key is already unique per event; the `swaps` view's
            -- row_number() is a presentation detail and is not stable across
            -- queries, so it would be the wrong thing to publish.
            'id', NEW.event_key,
            'pair', NEW.market,
            'user_address', NEW.payload->>'trader',
            'is_token0_in', (NEW.payload->>'asset_in_side') = 'base',
            'amount_in', COALESCE(NEW.payload->>'amount_in', '0'),
            'amount_out', COALESCE(NEW.payload->>'amount_out', '0'),
            'reserve0', COALESCE(NEW.payload->>'base_live_reserve', '0'),
            'reserve1', COALESCE(NEW.payload->>'quote_live_reserve', '0'),
            'timestamp', to_char(NEW.time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'tx_sig', NEW.transaction_signature,
            'slot', NEW.slot::text,
            -- Same fee split the view reports: the program names which side
            -- the fee was taken on rather than emitting both.
            'fee_paid0', CASE WHEN NEW.payload->>'fee_asset_side' = 'base'
                              THEN COALESCE(NEW.payload->>'base_fee', '0') ELSE '0' END,
            'fee_paid1', CASE WHEN NEW.payload->>'fee_asset_side' = 'quote'
                              THEN COALESCE(NEW.payload->>'base_fee', '0') ELSE '0' END,
            -- No price source in this pipeline, so these stay empty rather
            -- than carrying a fabricated number. The view makes the same call.
            'ema_price', '',
            'volume_usd', ''
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dusk_swap_notify ON dusk_ingestion.event_stream;

CREATE TRIGGER dusk_swap_notify
AFTER INSERT ON dusk_ingestion.event_stream
FOR EACH ROW
EXECUTE FUNCTION dusk_ingestion.notify_swap_executed();
