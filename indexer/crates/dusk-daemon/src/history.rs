//! Select only finalized signatures that belong to the attested release.
use {
    crate::identity::DeploymentWindow,
    anyhow::{bail, Result},
    std::ops::Range,
};

#[derive(Default)]
pub struct Pagination {
    previous_oldest: Option<u64>,
    seen: std::collections::HashSet<String>,
}
impl Pagination {
    pub fn select(
        &mut self,
        page: &[(&str, u64)],
        window: DeploymentWindow,
    ) -> Result<PageSelection> {
        if page.is_empty() {
            bail!("history lower boundary unavailable; an empty or pruned page cannot establish coverage");
        }
        if self
            .previous_oldest
            .is_some_and(|oldest| page[0].1 > oldest)
        {
            bail!("FINALIZED_INVARIANT: signature pages moved forward while backfilling");
        }
        for (signature, _) in page {
            if !self.seen.insert((*signature).to_owned()) {
                bail!("FINALIZED_INVARIANT: repeated signature in history pagination");
            }
        }
        self.previous_oldest = page.last().map(|entry| entry.1);
        select_page(
            &page.iter().map(|entry| entry.1).collect::<Vec<_>>(),
            window,
        )
    }
}

pub struct PageSelection {
    pub range: Range<usize>,
    pub reached_start: bool,
}
pub fn select_page(slots: &[u64], window: DeploymentWindow) -> Result<PageSelection> {
    if slots.windows(2).any(|pair| pair[0] < pair[1]) {
        bail!("FINALIZED_INVARIANT: signature page is not newest first");
    }
    let start = slots
        .iter()
        .position(|slot| *slot <= window.through_slot)
        .unwrap_or(slots.len());
    let end = slots
        .iter()
        .position(|slot| *slot < window.first_slot)
        .unwrap_or(slots.len());
    Ok(PageSelection {
        range: start..end,
        reached_start: end < slots.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_explicit_lower_boundary_across_short_and_same_slot_pages() {
        let window = DeploymentWindow {
            first_slot: 20,
            through_slot: 30,
        };
        let mut pages = Pagination::default();
        assert!(
            !pages
                .select(&[("a", 31), ("b", 25)], window)
                .unwrap()
                .reached_start
        );
        assert!(!pages.select(&[("c", 25)], window).unwrap().reached_start);
        assert!(pages.select(&[], window).is_err());
        assert!(!pages.select(&[("d", 20)], window).unwrap().reached_start);
        assert!(
            pages
                .select(&[("e", 20), ("f", 19)], window)
                .unwrap()
                .reached_start
        );
    }
    #[test]
    fn rejects_duplicate_future_signatures_and_backwards_pagination() {
        let window = DeploymentWindow {
            first_slot: 20,
            through_slot: 30,
        };
        let mut pages = Pagination::default();
        pages.select(&[("future", 31)], window).unwrap();
        assert!(pages.select(&[("future", 31)], window).is_err());
        let mut pages = Pagination::default();
        pages.select(&[("a", 25)], window).unwrap();
        assert!(pages.select(&[("b", 26)], window).is_err());
    }
    #[test]
    fn history_excludes_old_release_and_defers_newer_unattested_slots() {
        let window = DeploymentWindow {
            first_slot: 20,
            through_slot: 30,
        };
        let page = select_page(&[32, 31, 30, 30, 25, 20, 19, 2], window).unwrap();
        assert_eq!(page.range, 2..6);
        assert!(page.reached_start);
        let old = select_page(&[19, 1], window).unwrap();
        assert!(old.range.is_empty());
        assert!(old.reached_start);
        let future = select_page(&[35, 31], window).unwrap();
        assert!(future.range.is_empty());
        assert!(!future.reached_start);
        let boundary = select_page(&[25, 20, 20], window).unwrap();
        assert_eq!(boundary.range, 0..3);
        assert!(!boundary.reached_start);
        assert!(select_page(&[21, 22], window).is_err());
    }
}
