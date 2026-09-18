// DMI dram-controller baseline. A policy document, not code: the harness parses it as JSON after dropping comments.
// This is the controller block of Ramulator 2.0's shipped example_config.yaml (FRFCFS, all-bank refresh,
// closed-row policy that precharges after 4 column accesses, RoBaRaCoCh address mapping) plus the Generic
// controller's default write-drain watermarks (generic_dram_controller.cpp).
{
  "scheduler": "FRFCFS",
  "refresh": "AllBank",
  "row_policy": { "impl": "ClosedRowPolicy", "cap": 4 },
  "addr_mapper": "RoBaRaCoCh",
  "wr_low_watermark": 0.2,
  "wr_high_watermark": 0.8
}
