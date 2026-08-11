use {serde::Serialize, serde_json::Value, solana_pubkey::Pubkey, std::str::FromStr};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct UnsignedInteger(String);

impl UnsignedInteger {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SignedInteger(String);

impl SignedInteger {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AmmKind {
    ConstantProduct,
    Concentrated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetSide {
    Base,
    Quote,
    Unknown(u8),
}

impl AssetSide {
    fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Base,
            1 => Self::Quote,
            other => Self::Unknown(other),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuctionDestination {
    Fee,
    Buyback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RevenueSource {
    SwapFee,
    Interest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarketAssetProjection {
    pub asset_mint: String,
    pub decimals: u8,
    pub hlp_mint: String,
    pub reserve_vault: String,
    pub collateral_vault: String,
    pub interest_vault: String,
    pub live_reserve: UnsignedInteger,
    pub cash_reserve: UnsignedInteger,
    pub ylp_supply: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProtocolAuctionLaneProjection {
    pub market: String,
    pub sold_asset_side: AssetSide,
    pub sold_asset_mint: String,
    pub destination: AuctionDestination,
    pub revenue_source: RevenueSource,
    pub reference_market: String,
    pub liability: UnsignedInteger,
    pub epoch_start_slot: UnsignedInteger,
    pub tracked_inventory: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarketProjection {
    pub market: String,
    pub version: u8,
    pub ylp_mint: String,
    pub base: MarketAssetProjection,
    pub quote: MarketAssetProjection,
    /// Curve currently admitted by the protected-profit gate and executable by
    /// swaps.
    pub amm_kind: AmmKind,
    /// Governance/config target. This may differ from `amm_kind` while a ramp
    /// or deferred controller admission is pending.
    pub configured_amm_kind: AmmKind,
    pub initialized: bool,
    pub reduce_only: bool,
    pub params_hash_hex: String,
    pub last_marginal_observation_nad: UnsignedInteger,
    pub center_price_nad: UnsignedInteger,
    pub price_ema_nad: UnsignedInteger,
    pub last_trade_price_nad: UnsignedInteger,
    pub curve_revision: UnsignedInteger,
    pub risk_revision: UnsignedInteger,
    pub last_update_slot: UnsignedInteger,
    pub risk_snapshot_slot: UnsignedInteger,
    pub auction_lanes: Vec<ProtocolAuctionLaneProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BorrowPortfolioProjection {
    pub account: String,
    pub owner: String,
    pub market: String,
    pub position_id: String,
    pub base_collateral: UnsignedInteger,
    pub quote_collateral: UnsignedInteger,
    pub fixed_base_shares: UnsignedInteger,
    pub fixed_quote_shares: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeveragePortfolioProjection {
    pub account: String,
    pub owner: String,
    pub market: String,
    pub position_id: String,
    pub debt_asset: AssetSide,
    pub collateral_amount: UnsignedInteger,
    pub margin_amount: UnsignedInteger,
    pub open_notional: UnsignedInteger,
    pub debt_principal: UnsignedInteger,
    pub debt_shares: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeverageDelegationPortfolioProjection {
    pub account: String,
    pub owner: String,
    pub market: String,
    pub position: String,
    pub debt_asset: AssetSide,
    pub delegated_program: String,
    pub approved_actions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProposalSupportPortfolioProjection {
    pub account: String,
    pub proposal: String,
    pub supporter: String,
    pub locked_amount: UnsignedInteger,
    pub accrued_base_swap_fee: UnsignedInteger,
    pub accrued_base_interest: UnsignedInteger,
    pub accrued_quote_swap_fee: UnsignedInteger,
    pub accrued_quote_interest: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReferralAccrualPortfolioProjection {
    pub account: String,
    pub referral_partner: String,
    pub market: String,
    pub asset_mint: String,
    pub amount: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReferralPartnerPortfolioProjection {
    pub account: String,
    pub authority: String,
    pub recipient: String,
    pub interest_share_bps: u16,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct YieldPortfolioProjection {
    pub account: String,
    pub owner: String,
    pub market: String,
    pub lp_mint: String,
    pub asset_mint: String,
    pub token_kind_code: u8,
    pub recipient: String,
    pub accrued_swap_fee_amount: UnsignedInteger,
    pub accrued_interest_amount: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeverageOrderPortfolioProjection {
    pub account: String,
    pub owner: String,
    pub market: String,
    pub position: String,
    pub order_id: UnsignedInteger,
    pub kind_code: u8,
    pub trigger_closeout_price_nad: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PortfolioProjection {
    BorrowPosition(BorrowPortfolioProjection),
    LeveragePosition(LeveragePortfolioProjection),
    LeverageDelegation(LeverageDelegationPortfolioProjection),
    ProposalSupport(ProposalSupportPortfolioProjection),
    ReferralAccrual(ReferralAccrualPortfolioProjection),
    ReferralPartner(ReferralPartnerPortfolioProjection),
    YieldAccount(YieldPortfolioProjection),
    LeverageOrder(LeverageOrderPortfolioProjection),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BorrowLiquidationDiscoveryProjection {
    pub account: String,
    pub owner: String,
    pub market: String,
    pub position_id: String,
    pub base_collateral: UnsignedInteger,
    pub quote_collateral: UnsignedInteger,
    pub fixed_base_shares: UnsignedInteger,
    pub fixed_quote_shares: UnsignedInteger,
    pub global_health_base_contribution_for_quote_debt: UnsignedInteger,
    pub global_health_quote_contribution_for_base_debt: UnsignedInteger,
    pub base_liquidation_cf_bps: u16,
    pub quote_liquidation_cf_bps: u16,
    pub auction_debt_asset: AssetSide,
    pub auction_start_time: SignedInteger,
    pub auction_start_price_nad: UnsignedInteger,
    pub auction_floor_price_nad: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeverageLiquidationDiscoveryProjection {
    pub account: String,
    pub owner: String,
    pub market: String,
    pub position_id: String,
    pub debt_asset: AssetSide,
    pub collateral_amount: UnsignedInteger,
    pub margin_amount: UnsignedInteger,
    pub open_notional: UnsignedInteger,
    pub debt_principal: UnsignedInteger,
    pub debt_shares: UnsignedInteger,
    pub multiplier_bps: UnsignedInteger,
    pub opened_at: SignedInteger,
    pub opened_slot: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeverageOrderDiscoveryProjection {
    pub account: String,
    pub owner: String,
    pub market: String,
    pub position: String,
    pub order_id: UnsignedInteger,
    pub kind_code: u8,
    pub trigger_closeout_price_nad: UnsignedInteger,
    pub staged_margin: UnsignedInteger,
    pub staged_custody_token_account: String,
    pub staged_output_mint: String,
    pub staged_output_amount: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProposalExecutionDiscoveryProjection {
    pub proposal: String,
    pub market: String,
    pub proposer: String,
    pub nonce: UnsignedInteger,
    pub family: String,
    pub status: String,
    pub total_locked: UnsignedInteger,
    pub queued_support: UnsignedInteger,
    pub execute_after: SignedInteger,
    pub execution_deadline: SignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProtocolAuctionConfigDiscoveryProjection {
    pub authority_account: String,
    pub destination: AuctionDestination,
    pub accepted_mint: String,
    pub start_multiplier_bps: u16,
    pub floor_multiplier_bps: u16,
    pub duration_slots: UnsignedInteger,
    pub max_reference_age_slots: UnsignedInteger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeeperDiscoveryProjection {
    BorrowLiquidation(BorrowLiquidationDiscoveryProjection),
    LeverageLiquidation(LeverageLiquidationDiscoveryProjection),
    LeverageOrder(LeverageOrderDiscoveryProjection),
    ParameterProposalExecution(ProposalExecutionDiscoveryProjection),
    ProtocolAuctionLane(ProtocolAuctionLaneProjection),
    ProtocolAuctionConfig(ProtocolAuctionConfigDiscoveryProjection),
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct AccountProjections {
    pub market: Option<MarketProjection>,
    pub portfolio: Option<PortfolioProjection>,
    pub keeper_discovery: Vec<KeeperDiscoveryProjection>,
}

pub(super) fn build_product_projections(
    account_name: &str,
    account: &str,
    fields: &Value,
) -> Result<AccountProjections, String> {
    match account_name {
        "Market" => project_market(account, fields),
        "BorrowPosition" => project_borrow(account, fields),
        "LeveragePosition" => project_leverage(account, fields),
        "LeverageDelegation" => project_delegation(account, fields),
        "ProposalSupport" => project_proposal_support(account, fields),
        "ReferralAccrual" => project_referral_accrual(account, fields),
        "ReferralPartner" => project_referral_partner(account, fields),
        "YieldAccount" => project_yield(account, fields),
        "LeverageOrder" => project_leverage_order(account, fields),
        "ParameterProposal" => project_parameter_proposal(account, fields),
        "FutarchyAuthority" => project_futarchy_authority(account, fields),
        _ => Ok(AccountProjections::default()),
    }
}

fn project_market(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    let base = market_asset(fields, "base_side")?;
    let quote = market_asset(fields, "quote_side")?;
    let applied_peak = unsigned(
        fields,
        &["amm", "applied_curve_parameters", "peak_depth_nad"],
    )?;
    let applied_fade = unsigned(
        fields,
        &["amm", "applied_curve_parameters", "fade_scale_nad"],
    )?;
    let amm_kind = if applied_peak.as_str() == "0" && applied_fade.as_str() == "0" {
        AmmKind::ConstantProduct
    } else {
        AmmKind::Concentrated
    };
    let configured_peak = unsigned(fields, &["config", "amm", "peak_depth_nad"])?;
    let configured_fade = unsigned(fields, &["config", "amm", "fade_scale_nad"])?;
    let configured_amm_kind = if configured_peak.as_str() == "0" && configured_fade.as_str() == "0"
    {
        AmmKind::ConstantProduct
    } else {
        AmmKind::Concentrated
    };
    let mut lanes = auction_lanes(account, fields, AssetSide::Base, &base.asset_mint)?;
    lanes.extend(auction_lanes(
        account,
        fields,
        AssetSide::Quote,
        &quote.asset_mint,
    )?);
    let market = MarketProjection {
        market: account.to_owned(),
        version: small_u8(fields, &["version"])?,
        ylp_mint: pubkey(fields, &["ylp_mint"])?,
        base,
        quote,
        amm_kind,
        configured_amm_kind,
        initialized: boolean(fields, &["amm", "initialized"])?,
        reduce_only: boolean(fields, &["reduce_only"])?,
        params_hash_hex: hex_string(fields, &["params_hash"], 32)?,
        last_marginal_observation_nad: unsigned(fields, &["last_marginal_observation_nad"])?,
        center_price_nad: unsigned(fields, &["amm", "center_price_nad"])?,
        price_ema_nad: unsigned(fields, &["amm", "price_ema_nad"])?,
        last_trade_price_nad: unsigned(fields, &["amm", "last_trade_price_nad"])?,
        curve_revision: unsigned(fields, &["curve_revision"])?,
        risk_revision: unsigned(fields, &["risk_revision"])?,
        last_update_slot: unsigned(fields, &["last_update_slot"])?,
        risk_snapshot_slot: unsigned(fields, &["risk", "last_snapshot_slot"])?,
        auction_lanes: lanes.clone(),
    };
    Ok(AccountProjections {
        market: Some(market),
        portfolio: None,
        keeper_discovery: lanes
            .into_iter()
            .map(KeeperDiscoveryProjection::ProtocolAuctionLane)
            .collect(),
    })
}

fn market_asset(fields: &Value, side: &str) -> Result<MarketAssetProjection, String> {
    Ok(MarketAssetProjection {
        asset_mint: pubkey(fields, &[side, "asset_mint"])?,
        decimals: small_u8(fields, &[side, "asset_decimals"])?,
        hlp_mint: pubkey(fields, &[side, "hlp_mint"])?,
        reserve_vault: pubkey(fields, &[side, "reserve_vault"])?,
        collateral_vault: pubkey(fields, &[side, "collateral_vault"])?,
        interest_vault: pubkey(fields, &[side, "interest_vault"])?,
        live_reserve: unsigned(fields, &[side, "reserves", "live_reserve"])?,
        cash_reserve: unsigned(fields, &[side, "reserves", "cash_reserve"])?,
        ylp_supply: unsigned(fields, &[side, "shares", "ylp_supply"])?,
    })
}

fn auction_lanes(
    market: &str,
    fields: &Value,
    side: AssetSide,
    sold_asset_mint: &str,
) -> Result<Vec<ProtocolAuctionLaneProjection>, String> {
    let side_field = match side {
        AssetSide::Base => "base_side",
        AssetSide::Quote => "quote_side",
        AssetSide::Unknown(_) => return Err("market auction side is unknown".to_owned()),
    };
    let specs = [
        (
            AuctionDestination::Fee,
            RevenueSource::SwapFee,
            "fee_auction_reference_market",
            "swap_protocol_fee_liability",
            "fee_swap_auction_epoch",
        ),
        (
            AuctionDestination::Fee,
            RevenueSource::Interest,
            "fee_auction_reference_market",
            "interest_protocol_fee_liability",
            "fee_interest_auction_epoch",
        ),
        (
            AuctionDestination::Buyback,
            RevenueSource::SwapFee,
            "buyback_auction_reference_market",
            "swap_buyback_fee_liability",
            "buyback_swap_auction_epoch",
        ),
        (
            AuctionDestination::Buyback,
            RevenueSource::Interest,
            "buyback_auction_reference_market",
            "interest_buyback_fee_liability",
            "buyback_interest_auction_epoch",
        ),
    ];
    specs
        .into_iter()
        .map(
            |(destination, revenue_source, reference, liability, epoch)| {
                Ok(ProtocolAuctionLaneProjection {
                    market: market.to_owned(),
                    sold_asset_side: side,
                    sold_asset_mint: sold_asset_mint.to_owned(),
                    destination,
                    revenue_source,
                    reference_market: pubkey(fields, &[side_field, "fees", reference])?,
                    liability: unsigned(fields, &[side_field, "fees", liability])?,
                    epoch_start_slot: unsigned(fields, &[side_field, "fees", epoch, "start_slot"])?,
                    tracked_inventory: unsigned(
                        fields,
                        &[side_field, "fees", epoch, "tracked_inventory"],
                    )?,
                })
            },
        )
        .collect()
}

fn project_borrow(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    let portfolio = BorrowPortfolioProjection {
        account: account.to_owned(),
        owner: pubkey(fields, &["owner"])?,
        market: pubkey(fields, &["market"])?,
        position_id: pubkey(fields, &["position_id"])?,
        base_collateral: unsigned(fields, &["base_collateral"])?,
        quote_collateral: unsigned(fields, &["quote_collateral"])?,
        fixed_base_shares: unsigned(fields, &["fixed_base_shares"])?,
        fixed_quote_shares: unsigned(fields, &["fixed_quote_shares"])?,
    };
    let keeper = BorrowLiquidationDiscoveryProjection {
        account: portfolio.account.clone(),
        owner: portfolio.owner.clone(),
        market: portfolio.market.clone(),
        position_id: portfolio.position_id.clone(),
        base_collateral: portfolio.base_collateral.clone(),
        quote_collateral: portfolio.quote_collateral.clone(),
        fixed_base_shares: portfolio.fixed_base_shares.clone(),
        fixed_quote_shares: portfolio.fixed_quote_shares.clone(),
        global_health_base_contribution_for_quote_debt: unsigned(
            fields,
            &["global_health_base_contribution_for_quote_debt"],
        )?,
        global_health_quote_contribution_for_base_debt: unsigned(
            fields,
            &["global_health_quote_contribution_for_base_debt"],
        )?,
        base_liquidation_cf_bps: small_u16(fields, &["base_liquidation_cf_bps"])?,
        quote_liquidation_cf_bps: small_u16(fields, &["quote_liquidation_cf_bps"])?,
        auction_debt_asset: AssetSide::from_code(small_u8(fields, &["auction_debt_asset"])?),
        auction_start_time: signed(fields, &["auction_start_time"])?,
        auction_start_price_nad: unsigned(fields, &["auction_start_price_nad"])?,
        auction_floor_price_nad: unsigned(fields, &["auction_floor_price_nad"])?,
    };
    Ok(AccountProjections {
        market: None,
        portfolio: Some(PortfolioProjection::BorrowPosition(portfolio)),
        keeper_discovery: vec![KeeperDiscoveryProjection::BorrowLiquidation(keeper)],
    })
}

fn project_leverage(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    let debt_asset = AssetSide::from_code(small_u8(fields, &["debt_asset"])?);
    let portfolio = LeveragePortfolioProjection {
        account: account.to_owned(),
        owner: pubkey(fields, &["owner"])?,
        market: pubkey(fields, &["market"])?,
        position_id: pubkey(fields, &["position_id"])?,
        debt_asset,
        collateral_amount: unsigned(fields, &["collateral_amount"])?,
        margin_amount: unsigned(fields, &["margin_amount"])?,
        open_notional: unsigned(fields, &["open_notional"])?,
        debt_principal: unsigned(fields, &["debt_principal"])?,
        debt_shares: unsigned(fields, &["debt_shares"])?,
    };
    let keeper = LeverageLiquidationDiscoveryProjection {
        account: portfolio.account.clone(),
        owner: portfolio.owner.clone(),
        market: portfolio.market.clone(),
        position_id: portfolio.position_id.clone(),
        debt_asset,
        collateral_amount: portfolio.collateral_amount.clone(),
        margin_amount: portfolio.margin_amount.clone(),
        open_notional: portfolio.open_notional.clone(),
        debt_principal: portfolio.debt_principal.clone(),
        debt_shares: portfolio.debt_shares.clone(),
        multiplier_bps: unsigned(fields, &["multiplier_bps"])?,
        opened_at: signed(fields, &["opened_at"])?,
        opened_slot: unsigned(fields, &["opened_slot"])?,
    };
    Ok(AccountProjections {
        market: None,
        portfolio: Some(PortfolioProjection::LeveragePosition(portfolio)),
        keeper_discovery: vec![KeeperDiscoveryProjection::LeverageLiquidation(keeper)],
    })
}

fn project_delegation(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    Ok(AccountProjections {
        market: None,
        portfolio: Some(PortfolioProjection::LeverageDelegation(
            LeverageDelegationPortfolioProjection {
                account: account.to_owned(),
                owner: pubkey(fields, &["owner"])?,
                market: pubkey(fields, &["market"])?,
                position: pubkey(fields, &["position"])?,
                debt_asset: AssetSide::from_code(small_u8(fields, &["debt_asset"])?),
                delegated_program: pubkey(fields, &["delegated_program"])?,
                approved_actions: small_u32(fields, &["approved_actions"])?,
            },
        )),
        keeper_discovery: Vec::new(),
    })
}

fn project_proposal_support(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    Ok(AccountProjections {
        market: None,
        portfolio: Some(PortfolioProjection::ProposalSupport(
            ProposalSupportPortfolioProjection {
                account: account.to_owned(),
                proposal: pubkey(fields, &["proposal"])?,
                supporter: pubkey(fields, &["supporter"])?,
                locked_amount: unsigned(fields, &["locked_amount"])?,
                accrued_base_swap_fee: unsigned(
                    fields,
                    &["base_yield", "accrued_swap_fee_amount"],
                )?,
                accrued_base_interest: unsigned(
                    fields,
                    &["base_yield", "accrued_interest_amount"],
                )?,
                accrued_quote_swap_fee: unsigned(
                    fields,
                    &["quote_yield", "accrued_swap_fee_amount"],
                )?,
                accrued_quote_interest: unsigned(
                    fields,
                    &["quote_yield", "accrued_interest_amount"],
                )?,
            },
        )),
        keeper_discovery: Vec::new(),
    })
}

fn project_referral_accrual(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    Ok(AccountProjections {
        market: None,
        portfolio: Some(PortfolioProjection::ReferralAccrual(
            ReferralAccrualPortfolioProjection {
                account: account.to_owned(),
                referral_partner: pubkey(fields, &["referral_partner"])?,
                market: pubkey(fields, &["market"])?,
                asset_mint: pubkey(fields, &["asset_mint"])?,
                amount: unsigned(fields, &["amount"])?,
            },
        )),
        keeper_discovery: Vec::new(),
    })
}

fn project_referral_partner(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    Ok(AccountProjections {
        market: None,
        portfolio: Some(PortfolioProjection::ReferralPartner(
            ReferralPartnerPortfolioProjection {
                account: account.to_owned(),
                authority: pubkey(fields, &["authority"])?,
                recipient: pubkey(fields, &["recipient"])?,
                interest_share_bps: small_u16(fields, &["interest_share_bps"])?,
                active: boolean(fields, &["active"])?,
            },
        )),
        keeper_discovery: Vec::new(),
    })
}

fn project_yield(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    Ok(AccountProjections {
        market: None,
        portfolio: Some(PortfolioProjection::YieldAccount(
            YieldPortfolioProjection {
                account: account.to_owned(),
                owner: pubkey(fields, &["owner"])?,
                market: pubkey(fields, &["market"])?,
                lp_mint: pubkey(fields, &["lp_mint"])?,
                asset_mint: pubkey(fields, &["asset_mint"])?,
                token_kind_code: small_u8(fields, &["token_kind"])?,
                recipient: pubkey(fields, &["recipient"])?,
                accrued_swap_fee_amount: unsigned(fields, &["accrued_swap_fee_amount"])?,
                accrued_interest_amount: unsigned(fields, &["accrued_interest_amount"])?,
            },
        )),
        keeper_discovery: Vec::new(),
    })
}

fn project_leverage_order(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    let portfolio = LeverageOrderPortfolioProjection {
        account: account.to_owned(),
        owner: pubkey(fields, &["owner"])?,
        market: pubkey(fields, &["market"])?,
        position: pubkey(fields, &["position"])?,
        order_id: unsigned(fields, &["order_id"])?,
        kind_code: small_u8(fields, &["kind"])?,
        trigger_closeout_price_nad: unsigned(fields, &["trigger_closeout_price_nad"])?,
    };
    let keeper = LeverageOrderDiscoveryProjection {
        account: portfolio.account.clone(),
        owner: portfolio.owner.clone(),
        market: portfolio.market.clone(),
        position: portfolio.position.clone(),
        order_id: portfolio.order_id.clone(),
        kind_code: portfolio.kind_code,
        trigger_closeout_price_nad: portfolio.trigger_closeout_price_nad.clone(),
        staged_margin: unsigned(fields, &["staged_margin"])?,
        staged_custody_token_account: pubkey(fields, &["staged_custody_token_account"])?,
        staged_output_mint: pubkey(fields, &["staged_output_mint"])?,
        staged_output_amount: unsigned(fields, &["staged_output_amount"])?,
    };
    Ok(AccountProjections {
        market: None,
        portfolio: Some(PortfolioProjection::LeverageOrder(portfolio)),
        keeper_discovery: vec![KeeperDiscoveryProjection::LeverageOrder(keeper)],
    })
}

fn project_parameter_proposal(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    Ok(AccountProjections {
        market: None,
        portfolio: None,
        keeper_discovery: vec![KeeperDiscoveryProjection::ParameterProposalExecution(
            ProposalExecutionDiscoveryProjection {
                proposal: account.to_owned(),
                market: pubkey(fields, &["market"])?,
                proposer: pubkey(fields, &["proposer"])?,
                nonce: unsigned(fields, &["nonce"])?,
                family: enum_variant(fields, &["family"])?,
                status: enum_variant(fields, &["status"])?,
                total_locked: unsigned(fields, &["total_locked"])?,
                queued_support: unsigned(fields, &["queued_support"])?,
                execute_after: signed(fields, &["execute_after"])?,
                execution_deadline: signed(fields, &["execution_deadline"])?,
            },
        )],
    })
}

fn project_futarchy_authority(account: &str, fields: &Value) -> Result<AccountProjections, String> {
    let config = |destination, field: &'static str| -> Result<_, String> {
        Ok(KeeperDiscoveryProjection::ProtocolAuctionConfig(
            ProtocolAuctionConfigDiscoveryProjection {
                authority_account: account.to_owned(),
                destination,
                accepted_mint: pubkey(fields, &[field, "accepted_mint"])?,
                start_multiplier_bps: small_u16(
                    fields,
                    &[field, "params", "start_multiplier_bps"],
                )?,
                floor_multiplier_bps: small_u16(
                    fields,
                    &[field, "params", "floor_multiplier_bps"],
                )?,
                duration_slots: unsigned(fields, &[field, "params", "duration_slots"])?,
                max_reference_age_slots: unsigned(
                    fields,
                    &[field, "params", "max_reference_age_slots"],
                )?,
            },
        ))
    };
    Ok(AccountProjections {
        market: None,
        portfolio: None,
        keeper_discovery: vec![
            config(AuctionDestination::Fee, "fee_auction")?,
            config(AuctionDestination::Buyback, "buyback_auction")?,
        ],
    })
}

fn at<'a>(value: &'a Value, path: &[&str]) -> Result<&'a Value, String> {
    let mut current = value;
    for component in path {
        current = current
            .get(*component)
            .ok_or_else(|| format!("projection field {} is missing", path.join(".")))?;
    }
    Ok(current)
}

fn text(value: &Value, path: &[&str]) -> Result<String, String> {
    at(value, path)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("projection field {} is not a string", path.join(".")))
}

fn pubkey(value: &Value, path: &[&str]) -> Result<String, String> {
    let text = text(value, path)?;
    Pubkey::from_str(&text).map_err(|error| {
        format!(
            "projection field {} is not a pubkey: {error}",
            path.join(".")
        )
    })?;
    Ok(text)
}

fn unsigned(value: &Value, path: &[&str]) -> Result<UnsignedInteger, String> {
    let text = text(value, path)?;
    text.parse::<u128>().map_err(|error| {
        format!(
            "projection field {} is not an unsigned integer: {error}",
            path.join(".")
        )
    })?;
    Ok(UnsignedInteger(text))
}

fn signed(value: &Value, path: &[&str]) -> Result<SignedInteger, String> {
    let text = text(value, path)?;
    text.parse::<i128>().map_err(|error| {
        format!(
            "projection field {} is not a signed integer: {error}",
            path.join(".")
        )
    })?;
    Ok(SignedInteger(text))
}

fn small_u8(value: &Value, path: &[&str]) -> Result<u8, String> {
    unsigned(value, path)?
        .as_str()
        .parse()
        .map_err(|error| format!("projection field {} exceeds u8: {error}", path.join(".")))
}

fn small_u16(value: &Value, path: &[&str]) -> Result<u16, String> {
    unsigned(value, path)?
        .as_str()
        .parse()
        .map_err(|error| format!("projection field {} exceeds u16: {error}", path.join(".")))
}

fn small_u32(value: &Value, path: &[&str]) -> Result<u32, String> {
    unsigned(value, path)?
        .as_str()
        .parse()
        .map_err(|error| format!("projection field {} exceeds u32: {error}", path.join(".")))
}

fn boolean(value: &Value, path: &[&str]) -> Result<bool, String> {
    at(value, path)?
        .as_bool()
        .ok_or_else(|| format!("projection field {} is not a boolean", path.join(".")))
}

fn enum_variant(value: &Value, path: &[&str]) -> Result<String, String> {
    let mut variant_path = path.to_vec();
    variant_path.push("variant");
    text(value, &variant_path)
}

fn hex_string(value: &Value, path: &[&str], bytes: usize) -> Result<String, String> {
    let text = text(value, path)?;
    if text.len() != 2 + bytes * 2
        || !text.starts_with("0x")
        || !text[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!(
            "projection field {} is not a {bytes}-byte hex string",
            path.join(".")
        ));
    }
    Ok(text)
}
