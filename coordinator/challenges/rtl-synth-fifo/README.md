# rtl-synth-fifo: a FIFO with an in-line CRC-8, checked in Verilator and scored after Yosys synthesis

**Level:** L4 (synthesis, evaluator tier E1). **Objective:** `ppa`, lower is better.
**Time budget:** 300 s per trace for the whole run, of which synthesis gets at most 180 s.
**Tools:** Verilator 5, a C++ compiler, and Yosys.

## What the challenge is

Every accelerator front end has the same block in it: a queue that buffers words between two clocked stages
and computes a checksum over what passes through. The queue is small, it runs at the clock the whole design
is timed to, and it is instantiated hundreds of times. A design that is correct but slow sets the frequency
of everything around it. A design that is correct and small saves area on every instance.

The submission is that block. One synthesizable Verilog module named `dmi_fifo_crc`, with a fixed port list.
It must behave exactly like the golden model, and it is scored on what it costs in silicon.

The block is a 32-entry, 32-bit synchronous FIFO with:

- show-ahead output: `dout` is the head word whenever the FIFO is not empty, with no read enable
- `full`, `empty`, `almost_full` (28 entries or more) and `almost_empty` (4 entries or fewer)
- a 6-bit `count` of the entries held
- a running CRC-8 over every accepted pushed word: polynomial 0x07, init 0, no reflection, most significant
  byte of the word first

## Objective

`ppa` is cell area in square microns times the longest combinational path in nanoseconds. Lower is better.
Both numbers come from one Yosys run against the vendored `sky130_fd_sc_hd` typical corner:

- **area**: `stat -liberty` after `opt_clean`, the sum of the mapped cells' areas
- **delay**: abc's `stime`, which runs because the mapping passes `-constr`, reporting the longest
  combinational path with every input driven by a `buf_1` and 5 fF on every output

Two runs of the same source give the same number. The harness proves it by running the flow twice and
comparing the netlists before a score counts. The verdict also carries the cell count, the flop count, the
area and the delay on their own, so a submission can see which half it moved.

Correctness comes first. A design that disagrees with the model on any output in any cycle is invalid and is
never synthesized, so a smaller wrong answer scores nothing.

## The stimulus

`gen-trace.mjs` writes one line per clock, `<push><pop> <hex>`, where push and pop are 0 or 1 and hex is the
32-bit word on `din`. The public trace is seed 1 and 100,000 clocks. The hidden trace is another seed of the
same generator.

Phases run 40 to 400 clocks each and are drawn at random:

| Phase | push, pop | What it exercises |
| --- | --- | --- |
| fill | 0.9, 0.1 | filling up and sitting at full |
| drain | 0.1, 0.9 | draining and sitting at empty |
| balanced | 0.5, 0.5 | random traffic around the middle |
| stream | 1.0, 1.0 | a push and a pop in the same cycle, every cycle |
| trickle | 0.3, 0.3 | sparse traffic |
| hammer | 1.0, 0.0 | pushing into a full FIFO |
| bleed | 0.0, 1.0 | popping an empty FIFO |

One word in twenty is zero, all ones, or a single set bit, so a CRC that is wrong on an edge case is caught.

## What a submission is

One Verilog file. Exactly one module named `dmi_fifo_crc` with this port list, name for name:

```verilog
module dmi_fifo_crc (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        push,
  input  wire [31:0] din,
  input  wire        pop,
  output wire [31:0] dout,
  output wire        full,
  output wire        empty,
  output wire        almost_full,
  output wire        almost_empty,
  output wire [5:0]  count,
  output wire [7:0]  crc
);
```

Helper modules in the same file are allowed. The design is flattened before mapping, so a hierarchy costs
nothing and hides nothing.

The behavior the model expects:

- `do_push` is `push && !full` and `do_pop` is `pop && !empty`, both decided from the state before the clock
  edge. A push into a full FIFO is dropped. A pop of an empty FIFO returns nothing and changes nothing.
- `dout` is the head word whenever the FIFO is not empty. Its value when empty is not checked.
- `crc` covers accepted pushes only, and a push is visible in `crc` the cycle after it is taken.
- Reset is `rst_n` low for two clocks. After reset the FIFO is empty, `count` is 0 and `crc` is 0.
- Outputs are sampled before the clock edge, so a registered output is compared one cycle after the input
  that caused it, the same as any synchronous design.

## Rules

Checked before Verilator runs. Breaking one is an invalid submission with a message that says which rule.

- At most 64 KB of source.
- Exactly one module named `dmi_fifo_crc`, with the port list above and nothing added.
- Synthesizable only: no delays (`#`), no `fork`, `wait`, `force`, `release`, `event`, DPI `import` or
  `export`, `program`, `class`, `interface`, `bind` or `specify`.
- No `initial` blocks except constant register initialization.
- No system tasks except `$signed`, `$unsigned`, `$clog2` and `$bits`. That rules out `$system`, `$fopen`,
  `$display`, `$readmem` and `$c`.
- No `` `include ``. Directives are limited to `define`, `ifdef`, `ifndef`, `elsif`, `else`, `endif`, `undef`
  and `default_nettype`.
- No Verilator metacomments, so a lint warning cannot be waived from inside the submission.

Verilator's default warnings are fatal, and so is any Yosys warning: an inferred latch, an undriven wire, a
width mismatch, a cell that could not be mapped. The message comes back in the verdict. Fix the design rather
than trying to silence the tool.

The library is `sky130_fd_sc_hd__tt_025C_1v80`. Low-power flow cells, probe cells, clock buffers and delay
cells are marked `dont_use` for both `dfflibmap` and `abc`, the same list OpenROAD marks for this platform.

## Tool versions

Scoring runs **Yosys 0.52** with the abc that ships with it. Area and delay are that tool's own measurement, so
another Yosys version gives another number for the same design. A compute node reports this challenge only when
its `yosys -V` is 0.52, so every score in the network is comparable and two honest nodes never disagree because
their toolchains differ.

Any recent Verilator 5 runs the functional stage. That stage decides correct or not correct, and nothing about
the score, so its version does not matter.

Rank ideas locally on whatever you have installed, and read the score the network returns as the number that
counts. The numbers below were measured on a laptop with Yosys 0.68, so they are the right ratio and not the
absolute values production reports.

## Measured numbers (Apple silicon laptop, Verilator 5.052, Yosys 0.68, 2026-09-08)

| Design | Area (um2) | Delay (ns) | ppa | Versus baseline |
| --- | --- | --- | --- | --- |
| `baseline.v` | 41,486.04 | 2.896 | 120,123.24 | |
| `examples/synth-fifo-registered-flags.v` | 41,742.53 | 1.635 | 68,236.94 | 43.19% better |

The baseline uses binary pointers, a count register, combinational flags and a bit-serial CRC that folds four
bytes in one cycle. That serial CRC is the critical path. The example pays 256 um2 of area for a parallel CRC
and registered flags, and takes the delay down by 44 percent. The same numbers come back on the hidden seed,
because the score does not depend on the stimulus once the design is correct.

## Directions worth trying

- Registered flags and pointer comparisons instead of comparing the count
- A CRC computed in parallel over the whole word rather than byte by byte
- The storage structure and the read mux: a register file, a shift structure, or a memory the mapper likes
- One-hot or gray pointers
- Sharing the count with the pointers instead of keeping a third register

## Running it locally

```bash
brew install verilator yosys                      # or apt-get install verilator yosys
node coordinator/challenges/rtl-synth-fifo/gen-trace.mjs --seed 1 --out /tmp/public.trace
node coordinator/challenges/rtl-synth-fifo/harness.js coordinator/challenges/rtl-synth-fifo/baseline.v
node coordinator/challenges/rtl-synth-fifo/harness.js examples/synth-fifo-registered-flags.v
```

The harness prints the verdict as JSON: `ppa`, `area`, `delay`, cells, flops, the source hash and the netlist
fingerprint. `node --test test/synth.test.mjs` runs the challenge tests, and skips cleanly on a machine
without the tools.

## Provenance

Stimulus from `gen-trace.mjs` in this directory, deterministic from the seed. Functional check: Verilator
(verilator/verilator, LGPL-3.0 or Artistic-2.0) with the testbench `tb.cpp`. Synthesis: Yosys (YosysHQ/yosys,
ISC) with abc. Library: the `sky130_fd_sc_hd` typical corner from the SkyWater open PDK (Apache-2.0), vendored
here as a gzip with its sha256 pinned in the harness and checked on every run.
