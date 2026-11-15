BEGIN;
-- Derived income remains separate from the original immutable value history.
CREATE TABLE dusk_ingestion.portfolio_income_checkpoints (
  capture_id BIGINT NOT NULL,
  owner TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  income JSONB NOT NULL CHECK(jsonb_typeof(income)='object' AND jsonb_typeof(income->'streams')='array'
    AND jsonb_typeof(income->'unavailable')='array'),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(capture_id,owner),
  FOREIGN KEY(capture_id,owner) REFERENCES dusk_ingestion.portfolio_checkpoints(capture_id,owner)
);
CREATE TRIGGER dusk_portfolio_income_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.portfolio_income_checkpoints
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();
CREATE FUNCTION dusk_ingestion.check_portfolio_income_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original dusk_ingestion.portfolio_checkpoints%ROWTYPE;
BEGIN
  SELECT * INTO STRICT original FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=NEW.capture_id AND owner=NEW.owner;
  IF NEW.source_hash IS DISTINCT FROM original.coverage->>'sourceHash'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.income->'streams') s WHERE s->>'owner' IS DISTINCT FROM NEW.owner
      OR (s->>'sourceSlot')::bigint NOT BETWEEN original.source_min_slot AND original.source_max_slot)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.income->'unavailable') s WHERE s->>'owner' IS DISTINCT FROM NEW.owner) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: income checkpoint differs from its captured source';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_portfolio_income_source BEFORE INSERT ON dusk_ingestion.portfolio_income_checkpoints
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.check_portfolio_income_source();
COMMIT;
