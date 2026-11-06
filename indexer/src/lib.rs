//! Omnipair Indexer - A modular indexer for Omnipair protocol events
//!
//! This crate provides a clean, modular architecture for indexing Omnipair
//! protocol events from Solana blockchain transactions.

pub mod config;
pub mod database;
pub mod datasources;
pub mod pipeline;
pub mod processors;
pub mod signals;

// Re-export commonly used types for convenience
pub use {
    config::{Args, Config},
    database::{init_db_pool, upsert_swap_event},
    datasources::{GpaBackfillDatasource, create_helius_datasource},
    pipeline::{create_pipeline, run_pipeline},
    processors::OmnipairInstructionProcessor,
    signals::shutdown_signal,
};
