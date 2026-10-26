BEGIN;
-- Bound wallet contribution-history reads by protocol identity and position.
-- Canonical pointers remain authoritative; this index creates no new ledger.
CREATE INDEX dusk_position_cash_flow_events ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,(decoded_payload->>'position'),slot)
  WHERE commitment IN ('confirmed','finalized') AND event_name IN (
    'LeveragePositionOpened','LeveragePositionUpdated','LeveragePositionClosed',
    'LeveragePositionLiquidated','DebtFreePositionClosed','FlashLiquidationSettled','EmergencyLiquidationSettled');
COMMIT;
