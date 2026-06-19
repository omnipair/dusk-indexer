use std::sync::Arc;
use carbon_core::{error::CarbonResult, pipeline::Pipeline};
use carbon_omnipair_decoder::{OmnipairDecoder, PROGRAM_ID as OMNIPAIR_PROGRAM_ID};
use carbon_log_metrics::LogMetrics;
use carbon_prometheus_metrics::PrometheusMetrics;

use crate::{
    config::Config,
    datasources::{create_helius_datasource, create_transaction_crawler_datasource, OrderedBackfillDatasource},
    processors::OmnipairInstructionProcessor,
};

/// Creates and configures the indexer pipeline based on the provided configuration
pub async fn create_pipeline(config: &Config) -> CarbonResult<Pipeline> {
    // Require Helius API key for transaction monitoring
    let api_key = config.helius_api_key.as_ref()
        .ok_or_else(|| carbon_core::error::Error::Custom(
            "HELIUS_API_KEY is required for Atlas WS".to_string()
        ))?;

    log::info!("Using Helius Atlas WebSocket for realtime transaction monitoring");

    // Create Atlas WebSocket datasource
    let atlas_datasource = create_helius_datasource(api_key, *OMNIPAIR_PROGRAM_ID);

    // Create transaction crawler datasource (more efficient than block crawler)
    let _transaction_crawler_datasource = create_transaction_crawler_datasource(
        config.http_rpc_url.clone(),
        *OMNIPAIR_PROGRAM_ID,
        Some(config.start_block)
    ).await?;

    // Create instruction processor
    let instruction_processor = OmnipairInstructionProcessor::new();

    // Build the pipeline
    let pipeline = Pipeline::builder()
        //.datasource(_transaction_crawler_datasource)
        .datasource(atlas_datasource)
        .metrics(Arc::new(LogMetrics::new()))
        .metrics(Arc::new(PrometheusMetrics::new_with_port(config.metrics_port)))
        .metrics_flush_interval(3)
        .instruction(OmnipairDecoder, instruction_processor)
        .shutdown_strategy(carbon_core::pipeline::ShutdownStrategy::ProcessPending)
        .build()?;
    
    log::info!("Pipeline configured: historical transactions via RPC Transaction Crawler (TransactionUpdate)");

    Ok(pipeline)
}

/// Creates a one-shot backfill pipeline that replays historical transactions in
/// chronological order (oldest -> newest) starting at `from_slot`.
///
/// This reuses the same decoder and instruction processor (and therefore the
/// same DB-insert logic) as the realtime pipeline; the only difference is the
/// datasource, which feeds transactions oldest-first and then completes so the
/// pipeline shuts down on its own.
pub async fn create_backfill_pipeline(config: &Config, from_slot: u64) -> CarbonResult<Pipeline> {
    log::info!(
        "Configuring one-shot backfill pipeline (oldest -> newest) from slot {}",
        from_slot
    );

    let backfill_datasource = OrderedBackfillDatasource::new(
        config.http_rpc_url.clone(),
        *OMNIPAIR_PROGRAM_ID,
        from_slot,
    );

    let instruction_processor = OmnipairInstructionProcessor::new();

    let pipeline = Pipeline::builder()
        .datasource(backfill_datasource)
        .metrics(Arc::new(LogMetrics::new()))
        .metrics(Arc::new(PrometheusMetrics::new_with_port(config.metrics_port)))
        .metrics_flush_interval(3)
        .instruction(OmnipairDecoder, instruction_processor)
        .shutdown_strategy(carbon_core::pipeline::ShutdownStrategy::ProcessPending)
        .build()?;

    log::info!("Backfill pipeline configured, starting execution...");

    Ok(pipeline)
}

/// Runs the indexer pipeline with graceful shutdown handling
pub async fn run_pipeline(mut pipeline: Pipeline) -> CarbonResult<()> {
    log::info!("Pipeline configured, starting execution...");

    // Run pipeline with graceful shutdown handling
    tokio::select! {
        result = pipeline.run() => {
            match result {
                Ok(_) => {
                    log::info!("Pipeline completed successfully");
                    Ok(())
                }
                Err(e) => {
                    log::error!("Pipeline execution failed: {:?}", e);
                    Err(e)
                }
            }
        }
        _ = tokio::signal::ctrl_c() => {
            log::info!("Received shutdown signal (Ctrl+C)");
            log::info!("Shutting down gracefully...");
            Ok(())
        }
        _ = crate::signals::shutdown_signal() => {
            log::info!("Received system shutdown signal");
            log::info!("Shutting down gracefully...");
            Ok(())
        }
    }
}
