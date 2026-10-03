# Flux / ReRoute Synthetic Data Pack

Purpose: MHacks prototype data for a campus waste-collection digital twin.

FILES
- bins.csv: simulated smart-bin registry on approximate Ann Arbor/UM campus geography.
- telemetry_hourly.csv: 180 days of hourly synthetic bin telemetry.
- events.csv: synthetic operational event scenarios used to create demand spikes.
- collections.csv: collection events derived from simulated fill behavior.
- model_training.csv: feature table with a 6-hour future-fill regression target and overflow classification target.

IMPORTANT
- Bin locations, bin telemetry, event attendance, collections, and synthetic weather columns are simulated.
- Replace temperature_c_synthetic and precipitation_mm_synthetic with real Open-Meteo historical weather before final model training if time allows.
- Replace synthetic event scenarios with official event schedule fields for live/demo enrichment.
- Do not claim this is University of Michigan operational or sensor data.
- Coordinates are approximate prototype locations, not actual waste-bin locations.

RECOMMENDED MODEL TARGET
Regression: fill_pct_6h_later
Optional classification: overflow_within_6h

RECOMMENDED JOIN KEY
bin_id
