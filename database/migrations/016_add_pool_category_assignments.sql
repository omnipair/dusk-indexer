-- Migration: Add explicit pool category assignments
-- Description: Keeps reusable category metadata in token_categories, but makes
--              pool tags explicit by assigning categories directly to one pool
--              address at a time. Existing token-derived and legacy
--              pools.categories tags are backfilled into explicit assignments.

CREATE TABLE IF NOT EXISTS token_categories (
    id bigserial PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    label text NOT NULL,
    description text,
    icon_url text,
    is_archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS token_category_assignments (
    category_id bigint NOT NULL REFERENCES token_categories(id) ON DELETE CASCADE,
    token_mint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (category_id, token_mint)
);

CREATE TABLE IF NOT EXISTS pool_category_assignments (
    category_id bigint NOT NULL REFERENCES token_categories(id) ON DELETE CASCADE,
    pair_address varchar NOT NULL REFERENCES pools(pair_address) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (category_id, pair_address)
);

CREATE INDEX IF NOT EXISTS idx_pool_category_assignments_pair_address
    ON pool_category_assignments (pair_address);

CREATE INDEX IF NOT EXISTS idx_pool_category_assignments_category_id
    ON pool_category_assignments (category_id);

CREATE INDEX IF NOT EXISTS idx_token_categories_archived
    ON token_categories (is_archived);

CREATE INDEX IF NOT EXISTS idx_token_category_assignments_token_mint
    ON token_category_assignments (token_mint);

COMMENT ON TABLE pool_category_assignments IS
    'Explicit pool-level category assignments. This replaces token-derived category assignment for public pool tags.';

COMMENT ON TABLE token_category_assignments IS
    'Legacy token-level category assignments retained for backfill/history. Public pool categories are read from pool_category_assignments.';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pools'
          AND column_name = 'categories'
    ) THEN
        COMMENT ON COLUMN pools.categories IS
            'Legacy comma-separated pool category tags retained for backfill/history. Public pool categories are read from pool_category_assignments.';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION set_token_categories_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS token_categories_set_updated_at ON token_categories;

CREATE TRIGGER token_categories_set_updated_at
BEFORE UPDATE ON token_categories
FOR EACH ROW
EXECUTE FUNCTION set_token_categories_updated_at();

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pools'
          AND column_name = 'categories'
    ) THEN
        EXECUTE $sql$
            INSERT INTO token_categories (slug, label)
            SELECT DISTINCT
                slug,
                initcap(replace(slug, '-', ' ')) AS label
            FROM (
                SELECT lower(btrim(raw_category)) AS slug
                FROM pools p
                CROSS JOIN LATERAL regexp_split_to_table(COALESCE(p.categories, ''), ',') AS raw_category
                WHERE btrim(raw_category) <> ''
            ) legacy_categories
            WHERE slug <> ''
            ON CONFLICT (slug) DO NOTHING
        $sql$;
    END IF;
END $$;

INSERT INTO pool_category_assignments (category_id, pair_address)
SELECT DISTINCT
    tca.category_id,
    p.pair_address
FROM token_category_assignments tca
JOIN pools p
  ON p.token0 = tca.token_mint
  OR p.token1 = tca.token_mint
WHERE p.pair_address IS NOT NULL
ON CONFLICT (category_id, pair_address) DO NOTHING;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pools'
          AND column_name = 'categories'
    ) THEN
        EXECUTE $sql$
            INSERT INTO pool_category_assignments (category_id, pair_address)
            SELECT DISTINCT
                tc.id,
                p.pair_address
            FROM pools p
            CROSS JOIN LATERAL regexp_split_to_table(COALESCE(p.categories, ''), ',') AS raw_category
            JOIN token_categories tc
              ON tc.slug = lower(btrim(raw_category))
            WHERE p.pair_address IS NOT NULL
              AND btrim(raw_category) <> ''
            ON CONFLICT (category_id, pair_address) DO NOTHING
        $sql$;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION notify_pool_categories_updated()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'token_categories' THEN
        PERFORM pg_notify(
            'pool_updates',
            json_build_object(
                'op', TG_OP,
                'pair', 'pool-category-admin',
                'entity', TG_TABLE_NAME,
                'category_id', COALESCE(NEW.id, OLD.id)::text,
                'slug', COALESCE(NEW.slug, OLD.slug)
            )::text
        );
        RETURN COALESCE(NEW, OLD);
    END IF;

    PERFORM pg_notify(
        'pool_updates',
        json_build_object(
            'op', TG_OP,
            'pair', COALESCE(NEW.pair_address, OLD.pair_address),
            'entity', TG_TABLE_NAME,
            'category_id', COALESCE(NEW.category_id, OLD.category_id)::text
        )::text
    );

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS token_categories_notify ON token_categories;
DROP TRIGGER IF EXISTS pool_category_assignments_notify ON pool_category_assignments;

CREATE TRIGGER token_categories_notify
AFTER INSERT OR UPDATE OR DELETE ON token_categories
FOR EACH ROW
EXECUTE FUNCTION notify_pool_categories_updated();

CREATE TRIGGER pool_category_assignments_notify
AFTER INSERT OR DELETE ON pool_category_assignments
FOR EACH ROW
EXECUTE FUNCTION notify_pool_categories_updated();

DO $$
BEGIN
    RAISE NOTICE 'Migration 016: Created explicit pool category assignments and backfilled legacy categories';
END $$;
