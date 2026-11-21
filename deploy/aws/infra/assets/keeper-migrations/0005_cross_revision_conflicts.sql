BEGIN;
-- Stop all signing workers before upgrading to the revision-independent lease.
-- An upgrade never permits a second signature for an unresolved position/side.
-- Duplicate pending generations deliberately make this migration fail; reconcile
-- them before retrying rather than deleting transaction history.
CREATE UNIQUE INDEX keeper_flash_pending_across_revisions
  ON keeper_flash_work (position, debt_asset)
  WHERE outcome IN ('reserved','submitted_unknown');
COMMIT;
