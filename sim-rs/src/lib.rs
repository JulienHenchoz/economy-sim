//! Simulation d'économie d'une île : cœur en Rust, utilisable en natif (calibrage, longues
//! simulations) et en WebAssembly (interface web, voir `wasm.rs`).

pub mod config;
pub mod market;
pub mod sim;
pub mod util;
pub mod v8math;

pub use sim::Simulation;

#[cfg(target_arch = "wasm32")]
pub mod wasm;
