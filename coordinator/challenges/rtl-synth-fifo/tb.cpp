// DMI rtl-synth-fifo functional testbench. Drives a seeded push and pop stimulus into the submitted module
// (dmi_fifo_crc) and compares every output, every cycle, against a golden C++ model of the FIFO and its CRC.
// A design that disagrees once fails; synthesis never runs on it. This file is compiled together with the
// submission by Verilator and prints one JSON line with the result.
//
// The model (fixed, not part of the submission):
//   - 32 entries of 32 bits; count is the number of words held
//   - do_push = push && !full, do_pop = pop && !empty, both decided from the state before the clock edge;
//     a push into a full FIFO is dropped even when a pop happens in the same cycle
//   - full = count == 32, empty = count == 0, almost_full = count >= 28, almost_empty = count <= 4
//   - dout is the head word whenever the FIFO is not empty (show-ahead); it is not checked while empty
//   - crc is CRC-8 (polynomial 0x07, init 0x00, no reflection) over every accepted pushed word, bytes most
//     significant first, updated at the clock edge that accepts the push
//   - reset: rst_n low for two clocks with push and pop low; afterwards count is 0 and crc is 0
// Outputs are sampled after the inputs settle and before the clock edge, so they must be functions of the
// registered state and (for nothing in this contract) the inputs.
#include "Vdmi_fifo_crc.h"
#include "verilated.h"
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static const int DEPTH = 32, AF = 28, AE = 4;

struct Model {
  uint32_t mem[DEPTH];
  int head = 0, count = 0;
  uint8_t crc = 0;
  bool full() const { return count == DEPTH; }
  bool empty() const { return count == 0; }
  uint32_t dout() const { return mem[head]; }
  static uint8_t crcByte(uint8_t c, uint8_t b) {
    uint8_t t = c ^ b;
    for (int k = 0; k < 8; k++) t = (t & 0x80) ? (uint8_t)((t << 1) ^ 0x07) : (uint8_t)(t << 1);
    return t;
  }
  void step(bool push, bool pop, uint32_t din) {
    bool doPush = push && !full(), doPop = pop && !empty();
    if (doPush) {
      mem[(head + count) % DEPTH] = din;
      crc = crcByte(crcByte(crcByte(crcByte(crc, din >> 24), (din >> 16) & 0xff), (din >> 8) & 0xff), din & 0xff);
    }
    if (doPop) head = (head + 1) % DEPTH;
    count += (doPush ? 1 : 0) - (doPop ? 1 : 0);
  }
};

static uint64_t outHash = 1469598103934665603ULL; // FNV-1a over every sampled output
static inline void mix(uint64_t v) { outHash ^= v; outHash *= 1099511628211ULL; }

int main(int argc, char** argv) {
  Verilated::commandArgs(argc, argv);
  if (argc < 2) { fprintf(stderr, "usage: sim <trace>\n"); return 2; }
  FILE* f = fopen(argv[1], "rb");
  if (!f) { fprintf(stderr, "cannot open trace %s\n", argv[1]); return 2; }
  Vdmi_fifo_crc* dut = new Vdmi_fifo_crc;
  Model m;

  // Reset: two clocks with rst_n low.
  dut->rst_n = 0; dut->push = 0; dut->pop = 0; dut->din = 0;
  for (int i = 0; i < 2; i++) { dut->clk = 0; dut->eval(); dut->clk = 1; dut->eval(); }
  dut->rst_n = 1;

  uint64_t cycles = 0, pushes = 0, pops = 0, mismatches = 0, maxCount = 0;
  char firstMismatch[160] = "";
  char buf[64];
  while (fgets(buf, sizeof buf, f)) {
    if (buf[0] != '0' && buf[0] != '1') continue;
    bool push = buf[0] == '1', pop = buf[1] == '1';
    uint32_t din = (uint32_t)strtoul(buf + 3, nullptr, 16);
    cycles++;
    dut->clk = 0; dut->push = push; dut->pop = pop; dut->din = din; dut->eval();

    // Compare the outputs against the model's state before the edge.
    const char* bad = nullptr; uint64_t want = 0, got = 0;
    if ((dut->full & 1) != (m.full() ? 1 : 0)) { bad = "full"; want = m.full(); got = dut->full & 1; }
    else if ((dut->empty & 1) != (m.empty() ? 1 : 0)) { bad = "empty"; want = m.empty(); got = dut->empty & 1; }
    else if ((dut->almost_full & 1) != (m.count >= AF ? 1 : 0)) { bad = "almost_full"; want = m.count >= AF; got = dut->almost_full & 1; }
    else if ((dut->almost_empty & 1) != (m.count <= AE ? 1 : 0)) { bad = "almost_empty"; want = m.count <= AE; got = dut->almost_empty & 1; }
    else if ((dut->count & 0x3f) != (unsigned)m.count) { bad = "count"; want = m.count; got = dut->count & 0x3f; }
    else if ((dut->crc & 0xff) != m.crc) { bad = "crc"; want = m.crc; got = dut->crc & 0xff; }
    else if (!m.empty() && dut->dout != m.dout()) { bad = "dout"; want = m.dout(); got = dut->dout; }
    if (bad) {
      mismatches++;
      if (!firstMismatch[0]) snprintf(firstMismatch, sizeof firstMismatch, "cycle %llu: %s is 0x%llx, expected 0x%llx (push=%d pop=%d din=0x%08x count=%d)", (unsigned long long)cycles, bad, (unsigned long long)got, (unsigned long long)want, push, pop, din, m.count);
      if (mismatches >= 1) break; // stop at the first disagreement
    }
    mix(((uint64_t)(dut->full & 1) << 0) | ((uint64_t)(dut->empty & 1) << 1) | ((uint64_t)(dut->almost_full & 1) << 2) | ((uint64_t)(dut->almost_empty & 1) << 3) | ((uint64_t)(dut->count & 0x3f) << 8) | ((uint64_t)(dut->crc & 0xff) << 16));
    if (!m.empty()) mix(0x100000000ULL | dut->dout);

    if (push && !m.full()) pushes++;
    if (pop && !m.empty()) pops++;
    m.step(push, pop, din);
    if ((uint64_t)m.count > maxCount) maxCount = m.count;
    dut->clk = 1; dut->eval();
  }
  fclose(f);
  dut->final();
  printf("{\"cycles\":%llu,\"pushes\":%llu,\"pops\":%llu,\"maxCount\":%llu,\"mismatches\":%llu,\"firstMismatch\":\"%s\",\"outputHash\":\"%016llx\"}\n",
         (unsigned long long)cycles, (unsigned long long)pushes, (unsigned long long)pops, (unsigned long long)maxCount, (unsigned long long)mismatches, firstMismatch, (unsigned long long)outHash);
  delete dut;
  return 0;
}
