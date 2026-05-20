-- Migration: Add token category tables and cache invalidation trigger
-- Description: Stores normalized token-level categories/tags plus assignments,
--              and emits pool_updates notifications so the API can invalidate
--              enriched pool cache entries when category state changes.

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

CREATE INDEX IF NOT EXISTS idx_token_category_assignments_token_mint
    ON token_category_assignments (token_mint);

CREATE INDEX IF NOT EXISTS idx_token_categories_archived
    ON token_categories (is_archived);

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

CREATE OR REPLACE FUNCTION notify_token_categories_updated()
RETURNS TRIGGER AS $$
DECLARE
    affected_pair text;
BEGIN
    IF TG_TABLE_NAME = 'token_categories' THEN
        PERFORM pg_notify(
            'pool_updates',
            json_build_object(
                'op', TG_OP,
                'pair', 'token-category-admin',
                'entity', TG_TABLE_NAME,
                'category_id', COALESCE(NEW.id, OLD.id)::text,
                'slug', COALESCE(NEW.slug, OLD.slug)
            )::text
        );
        RETURN COALESCE(NEW, OLD);
    END IF;

    SELECT p.pair_address
    INTO affected_pair
    FROM pools p
    WHERE p.token0 = COALESCE(NEW.token_mint, OLD.token_mint)
       OR p.token1 = COALESCE(NEW.token_mint, OLD.token_mint)
    ORDER BY p.pair_address
    LIMIT 1;

    PERFORM pg_notify(
        'pool_updates',
        json_build_object(
            'op', TG_OP,
            'pair', COALESCE(affected_pair, 'token-category-assignment'),
            'entity', TG_TABLE_NAME,
            'token_mint', COALESCE(NEW.token_mint, OLD.token_mint),
            'category_id', COALESCE(NEW.category_id, OLD.category_id)::text
        )::text
    );

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS token_categories_notify ON token_categories;
DROP TRIGGER IF EXISTS token_category_assignments_notify ON token_category_assignments;

CREATE TRIGGER token_categories_notify
AFTER INSERT OR UPDATE OR DELETE ON token_categories
FOR EACH ROW
EXECUTE FUNCTION notify_token_categories_updated();

CREATE TRIGGER token_category_assignments_notify
AFTER INSERT OR DELETE ON token_category_assignments
FOR EACH ROW
EXECUTE FUNCTION notify_token_categories_updated();

DO $$
BEGIN
    RAISE NOTICE 'Migration 015: Successfully created token category tables and pool cache invalidation trigger';
END $$;
