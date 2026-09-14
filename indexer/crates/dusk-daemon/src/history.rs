//! Select only finalized signatures that belong to the attested release.
use {
    crate::identity::DeploymentWindow,
    anyhow::{bail, Result},
    std::ops::Range,
};

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
