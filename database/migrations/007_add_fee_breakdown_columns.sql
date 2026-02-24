-- Migration: Add LP fee and protocol fee breakdown columns to swaps
-- Stores raw fee values (in input token) and their USD equivalents

ALTER TABLE swaps
    ADD COLUMN IF NOT EXISTS lp_fee NUMERIC,
    ADD COLUMN IF NOT EXISTS protocol_fee NUMERIC,
    ADD COLUMN IF NOT EXISTS lp_fee_usd NUMERIC DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS protocol_fee_usd NUMERIC DEFAULT NULL;

-- Update the notification trigger to include the new fee columns
CREATE OR REPLACE FUNCTION notify_swap_updated()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify(
        'swap_updates',
        json_build_object(
            'op', TG_OP,
            'id', NEW.id::text,
            'pair', NEW.pair,
            'user_address', NEW.user_address,
            'is_token0_in', NEW.is_token0_in,
            'amount_in', NEW.amount_in::text,
            'amount_out', NEW.amount_out::text,
            'reserve0', NEW.reserve0::text,
            'reserve1', NEW.reserve1::text,
            'timestamp', to_char(NEW.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'tx_sig', NEW.tx_sig,
            'slot', NEW.slot::text,
            'fee_paid0', NEW.fee_paid0::text,
            'fee_paid1', NEW.fee_paid1::text,
            'lp_fee', COALESCE(NEW.lp_fee::text, ''),
            'protocol_fee', COALESCE(NEW.protocol_fee::text, ''),
            'ema_price', COALESCE(NEW.ema_price::text, ''),
            'volume_usd', COALESCE(NEW.volume_usd::text, '')
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
