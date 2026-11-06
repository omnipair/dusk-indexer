use {
    super::super::types::*,
    carbon_core::{CarbonDeserialize, borsh},
};

#[derive(
    CarbonDeserialize, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq, Clone, Hash,
)]
#[carbon(discriminator = "0xaff7a0b68c80d3e2")]
pub struct FutarchyAuthority {
    pub version: u8,
    pub authority: solana_pubkey::Pubkey,
    pub recipients: RevenueRecipients,
    pub revenue_share: RevenueShare,
    pub revenue_distribution: RevenueDistribution,
    pub global_reduce_only: bool,
    pub bump: u8,
}
