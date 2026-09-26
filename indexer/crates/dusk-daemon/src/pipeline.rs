//! The Carbon pipeline, as in the v1 indexer: a Helius Atlas WebSocket
//! `transactionSubscribe` at confirmed commitment feeding one processor.

use {
    crate::{
        liveness::StreamLiveness,
        processors::{DuskInstructions, DuskTransactionProcessor},
    },
    anyhow::{bail, Result},
    carbon_core::pipeline::{Pipeline, ShutdownStrategy},
    carbon_helius_atlas_ws_datasource::{Filters, HeliusWebsocket},
    carbon_log_metrics::LogMetrics,
    carbon_prometheus_metrics::PrometheusMetrics,
    dusk_indexer_foundation::{DUSK_PROGRAM_ID, LEVERAGE_DELEGATE_PROGRAM_ID},
    helius::types::{
        Cluster, RpcTransactionsConfig, TransactionCommitment, TransactionDetails,
        TransactionSubscribeFilter, TransactionSubscribeOptions, UiEnhancedTransactionEncoding,
    },
    std::{collections::HashSet, sync::Arc},
    tokio::sync::RwLock,
};

/// Every successful transaction that touches either pinned program, pushed as
/// soon as it is confirmed. Votes and failed transactions are filtered out.
pub fn helius_datasource(api_key: &str, cluster: &str) -> Result<HeliusWebsocket> {
    let cluster = match cluster {
        "devnet" => Cluster::Devnet,
        "mainnet-beta" | "mainnet" => Cluster::MainnetBeta,
        other => bail!("unsupported cluster {other}"),
    };
    let filters = Filters {
        accounts: vec![],
        transactions: Some(RpcTransactionsConfig {
            filter: TransactionSubscribeFilter {
                account_include: Some(vec![
                    DUSK_PROGRAM_ID.to_owned(),
                    LEVERAGE_DELEGATE_PROGRAM_ID.to_owned(),
                ]),
                account_exclude: None,
                account_required: None,
                vote: Some(false),
                failed: Some(false),
                signature: None,
            },
            options: TransactionSubscribeOptions {
                commitment: Some(TransactionCommitment::Confirmed),
                encoding: Some(UiEnhancedTransactionEncoding::Base64),
                transaction_details: Some(TransactionDetails::Full),
                show_rewards: None,
                max_supported_transaction_version: Some(0),
            },
        }),
    };
    Ok(HeliusWebsocket::new(
        api_key.to_owned(),
        filters,
        Arc::new(RwLock::new(HashSet::new())),
        cluster,
    ))
}

/// `liveness` outlives each pipeline: the heartbeat reads it across rebuilds.
pub fn build(
    datasource: HeliusWebsocket,
    processor: DuskTransactionProcessor,
    metrics_port: u16,
    liveness: Arc<StreamLiveness>,
) -> carbon_core::error::CarbonResult<Pipeline> {
    Pipeline::builder()
        .datasource(datasource)
        .metrics(Arc::new(LogMetrics::new()))
        .metrics(Arc::new(PrometheusMetrics::new_with_port(metrics_port)))
        .metrics(liveness)
        .metrics_flush_interval(3)
        .transaction::<DuskInstructions, ()>(processor, None)
        .shutdown_strategy(ShutdownStrategy::ProcessPending)
        .build()
}
