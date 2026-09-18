// DMI rtl-cache-controller testbench. Cycle-accurate model of a 16 KB, 4-way, 64-byte-line cache in front of an
// in-order core, driven by a memory access trace. The submitted module (dmi_cache_policy) chooses which way to
// replace on every fill and may ask for prefetches. This file is the scorer: it is compiled together with the
// submission by Verilator and prints one JSON line with the result.
//
// Timing model (fixed, not part of the submission):
//   - every access costs 1 cycle
//   - a demand miss stalls the core until its fill returns: memory latency is LATENCY cycles from issue, and the
//     memory channel issues at most one fill every ISSUE cycles (demand and prefetch fills share the channel)
//   - a prefetch never stalls the core; it occupies an issue slot and one of MAX_INFLIGHT fill slots until it
//     returns, then it is installed in the cache (the policy picks the way, with access_prefetch high)
//   - a demand miss on a line whose prefetch is in flight waits only for the remaining latency
//   - evicting a dirty line writes it back: one issue slot on the channel, no core stall
//
// Total cycles = accesses + stall cycles. Lower is better.
//
// Policy events (one clock each):
//   access_valid=1, access_hit=1, access_way=w        a demand hit in way w
//   access_valid=1, access_hit=0, access_prefetch=0    a demand fill; victim_way is the way overwritten
//   access_valid=1, access_hit=0, access_prefetch=1    a prefetch fill; victim_way is the way overwritten
// victim_way is read combinationally in the same cycle, before the clock edge. prefetch_valid/prefetch_addr are
// read in the same cycle with prefetch_ready driven high when a fill slot and the channel are free; the request is
// taken on that clock edge.
#include "Vdmi_cache_policy.h"
#include "verilated.h"
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

static const int SETS = 64, WAYS = 4, LINE_SHIFT = 6, SET_BITS = 6;
static const uint64_t LATENCY = 40, ISSUE = 4, MAX_INFLIGHT = 4;

struct Line { bool valid = false, dirty = false; uint32_t tag = 0; };
struct Fill { uint32_t line; uint64_t completeAt; };

static Vdmi_cache_policy* dut;
static Line cache[SETS][WAYS];
static std::vector<Fill> inflight;
static uint64_t cycle = 0, nextIssue = 0, stalls = 0, hits = 0, misses = 0, prefetches = 0, prefetchHits = 0, prefetchDropped = 0, writebacks = 0, events = 0;
static uint64_t decisionHash = 1469598103934665603ULL; // FNV-1a over every decision the policy makes

static inline void mix(uint64_t v) { decisionHash ^= v; decisionHash *= 1099511628211ULL; }
static inline uint32_t setOf(uint32_t line) { return line & (SETS - 1); }
static inline uint32_t tagOf(uint32_t line) { return line >> SET_BITS; }

static int findWay(uint32_t line) {
  Line* s = cache[setOf(line)];
  for (int w = 0; w < WAYS; w++) if (s[w].valid && s[w].tag == tagOf(line)) return w;
  return -1;
}
static bool isInflight(uint32_t line) { for (auto& f : inflight) if (f.line == line) return true; return false; }

/** Issue one fill on the channel. Returns the cycle it completes. */
static uint64_t issue() {
  uint64_t at = cycle > nextIssue ? cycle : nextIssue;
  nextIssue = at + ISSUE;
  return at + LATENCY;
}

static void drive(bool valid, uint32_t addr, bool hit, int way, bool write, bool prefetch) {
  dut->access_valid = valid;
  dut->access_addr = addr;
  dut->access_set = (addr >> LINE_SHIFT) & (SETS - 1);
  dut->access_hit = hit;
  dut->access_way = way & (WAYS - 1);
  dut->access_write = write;
  dut->access_prefetch = prefetch;
}

/** One policy event: settle combinational outputs, take the prefetch handshake, then clock. Returns victim_way. */
static int event(bool valid, uint32_t addr, bool hit, int way, bool write, bool prefetch) {
  events++;
  dut->clk = 0;
  drive(valid, addr, hit, way, write, prefetch);
  bool ready = inflight.size() < MAX_INFLIGHT && nextIssue <= cycle;
  dut->prefetch_ready = ready;
  dut->eval();
  int victim = dut->victim_way & (WAYS - 1);
  if (dut->prefetch_valid && ready) {
    uint32_t line = dut->prefetch_addr >> LINE_SHIFT;
    mix(0x50000000ULL | line);
    if (findWay(line) >= 0 || isInflight(line)) prefetchDropped++;
    else { inflight.push_back({ line, issue() }); prefetches++; }
  }
  dut->clk = 1;
  dut->eval();
  return victim;
}

/** Install a line in its set at the policy's victim way. */
static void install(uint32_t line, bool write, bool prefetch) {
  uint32_t addr = line << LINE_SHIFT;
  int way = event(true, addr, false, 0, write, prefetch);
  mix(((uint64_t)line << 2) | way);
  Line& l = cache[setOf(line)][way];
  if (l.valid && l.dirty) { writebacks++; nextIssue = (cycle > nextIssue ? cycle : nextIssue) + ISSUE; }
  l.valid = true; l.tag = tagOf(line); l.dirty = write;
}

/** Retire every prefetch that has returned by now, in completion order. */
static void retire() {
  for (;;) {
    int best = -1;
    for (size_t i = 0; i < inflight.size(); i++) if (inflight[i].completeAt <= cycle && (best < 0 || inflight[i].completeAt < inflight[best].completeAt)) best = (int)i;
    if (best < 0) return;
    Fill f = inflight[best];
    inflight.erase(inflight.begin() + best);
    if (findWay(f.line) < 0) install(f.line, false, true);
  }
}

int main(int argc, char** argv) {
  Verilated::commandArgs(argc, argv);
  if (argc < 2) { fprintf(stderr, "usage: sim <trace> [maxAccesses]\n"); return 2; }
  uint64_t maxAccesses = argc > 2 ? strtoull(argv[2], nullptr, 10) : 0;
  FILE* f = fopen(argv[1], "rb");
  if (!f) { fprintf(stderr, "cannot open trace %s\n", argv[1]); return 2; }
  dut = new Vdmi_cache_policy;

  // Reset: two clocks with rst_n low and no event.
  dut->rst_n = 0; dut->prefetch_ready = 0; drive(false, 0, false, 0, false, false);
  for (int i = 0; i < 2; i++) { dut->clk = 0; dut->eval(); dut->clk = 1; dut->eval(); }
  dut->rst_n = 1;

  uint64_t accesses = 0, reads = 0, writes = 0;
  char buf[64];
  while (fgets(buf, sizeof buf, f)) {
    if (buf[0] != 'R' && buf[0] != 'W') continue;
    bool write = buf[0] == 'W';
    uint32_t addr = (uint32_t)strtoul(buf + 2, nullptr, 16);
    accesses++; if (write) writes++; else reads++;
    cycle++;
    retire();
    uint32_t line = addr >> LINE_SHIFT;
    int way = findWay(line);
    if (way >= 0) {
      hits++;
      if (write) cache[setOf(line)][way].dirty = true;
      event(true, addr, true, way, write, false);
    } else {
      misses++;
      uint64_t done = 0;
      bool wasPrefetch = false;
      for (size_t i = 0; i < inflight.size(); i++) if (inflight[i].line == line) { done = inflight[i].completeAt; inflight.erase(inflight.begin() + i); wasPrefetch = true; break; }
      if (!wasPrefetch) done = issue(); else prefetchHits++;
      if (done > cycle) { stalls += done - cycle; cycle = done; }
      retire();
      if (findWay(line) < 0) install(line, write, wasPrefetch);
      else if (write) cache[setOf(line)][findWay(line)].dirty = true;
    }
    if (maxAccesses && accesses >= maxAccesses) break;
  }
  fclose(f);
  dut->final();
  printf("{\"accesses\":%llu,\"reads\":%llu,\"writes\":%llu,\"cycles\":%llu,\"stalls\":%llu,\"hits\":%llu,\"misses\":%llu,"
         "\"prefetches\":%llu,\"prefetchHits\":%llu,\"prefetchDropped\":%llu,\"writebacks\":%llu,\"events\":%llu,\"decisionHash\":\"%016llx\"}\n",
         (unsigned long long)accesses, (unsigned long long)reads, (unsigned long long)writes, (unsigned long long)cycle, (unsigned long long)stalls,
         (unsigned long long)hits, (unsigned long long)misses, (unsigned long long)prefetches, (unsigned long long)prefetchHits,
         (unsigned long long)prefetchDropped, (unsigned long long)writebacks, (unsigned long long)events, (unsigned long long)decisionHash);
  delete dut;
  return 0;
}
