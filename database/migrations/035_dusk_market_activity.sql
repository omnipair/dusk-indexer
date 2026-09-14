BEGIN;
-- Finalized economic event sources. Derived USD values remain tied to a
-- separately captured as-of price; current balances never rewrite history.
CREATE TABLE dusk_ingestion.market_activity_events (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  event_key TEXT NOT NULL, observation_id BIGINT NOT NULL,
  event_name TEXT NOT NULL CHECK(event_name IN ('SwapExecuted','LeveragePositionOpened','LeveragePositionUpdated',
    'LeveragePositionClosed','LeveragePositionLiquidated','MarketDebtUpdated','HlpClosed','HlpTerminalLiquidated')),
  market TEXT NOT NULL, signature TEXT NOT NULL, slot BIGINT NOT NULL CHECK(slot>=0), blockhash TEXT NOT NULL,
  block_time TIMESTAMPTZ NOT NULL CHECK(isfinite(block_time)), payload JSONB NOT NULL,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision,event_key),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    REFERENCES dusk_ingestion.event_observations(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
);
CREATE INDEX dusk_market_activity_time ON dusk_ingestion.market_activity_events
  (cluster,program_id,idl_hash,protocol_revision,block_time,slot,event_key);
CREATE INDEX dusk_market_activity_market ON dusk_ingestion.market_activity_events
  (cluster,program_id,idl_hash,protocol_revision,market,block_time);
CREATE FUNCTION dusk_ingestion.check_market_activity_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    WHERE (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key,c.observation_id)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.event_key,NEW.observation_id)
      AND c.commitment='finalized' AND o.commitment='finalized' AND o.event_name=NEW.event_name
      AND o.transaction_signature=NEW.signature AND o.slot=NEW.slot AND o.blockhash=NEW.blockhash
      AND o.decoded_payload=NEW.payload AND NEW.market=NEW.payload->>'market')
    OR (SELECT count(*) FROM dusk_ingestion.event_stream s WHERE
      (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.event_key))<>1
    OR NOT EXISTS (SELECT 1 FROM dusk_ingestion.event_stream s WHERE
      (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.event_key)
      AND s.time=NEW.block_time AND s.slot=NEW.slot AND s.transaction_signature=NEW.signature
      AND s.event_name=NEW.event_name AND s.market=NEW.market AND s.payload=NEW.payload) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: native market activity lacks its exact canonical event-time source';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_market_activity_source BEFORE INSERT ON dusk_ingestion.market_activity_events
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.check_market_activity_source();
CREATE TRIGGER dusk_market_activity_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.market_activity_events
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();
CREATE TRIGGER dusk_market_activity_notify AFTER INSERT ON dusk_ingestion.market_activity_events
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_native_event();
COMMIT;
