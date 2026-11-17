BEGIN;
-- Current streamed payloads already use senior LP names. The compatibility
-- views can read one payload many times per historical event; rebuilding its
-- complete JSON tree on every read made statistics approach their deadline.
-- Only keys containing these exact legacy spellings can change. Modern trees
-- and scalar values are already the result, while legacy trees retain the
-- original recursive conversion and conflicting-key rejection.
CREATE OR REPLACE FUNCTION dusk_ingestion.senior_lp_payload(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result jsonb; entry record; renamed text;
BEGIN
  IF jsonb_typeof(value) NOT IN ('object','array') OR value::text !~ 'ylp|Ylp|YLP' THEN
    RETURN value;
  END IF;
  IF jsonb_typeof(value)='object' THEN
    result='{}'::jsonb;
    FOR entry IN SELECT * FROM jsonb_each(value) LOOP
      renamed=replace(replace(replace(entry.key,'ylp','srlp'),'Ylp','Srlp'),'YLP','SRLP');
      IF result ? renamed THEN RAISE EXCEPTION 'Conflicting senior LP payload fields'; END IF;
      result=result||jsonb_build_object(renamed,dusk_ingestion.senior_lp_payload(entry.value));
    END LOOP;
    RETURN result;
  ELSIF jsonb_typeof(value)='array' THEN
    SELECT COALESCE(jsonb_agg(dusk_ingestion.senior_lp_payload(item) ORDER BY ordinal),'[]'::jsonb)
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item,ordinal);
    RETURN result;
  END IF;
  RETURN value;
END $$;
COMMIT;
