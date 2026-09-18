// DMI rtl-cache-controller baseline: true LRU per set, no prefetch.
// Each set keeps a 2-bit age per way. Age 0 is most recently used, age 3 is least recently used.
// On a hit or a fill to way w: every way younger than w ages by one, w becomes 0. The victim is the way at age 3.
// After reset every set holds ages 3, 2, 1, 0, so cold sets fill way 0, then 1, 2, 3.
module dmi_cache_policy (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        access_valid,
  input  wire [31:0] access_addr,
  input  wire [5:0]  access_set,
  input  wire        access_hit,
  input  wire [1:0]  access_way,
  input  wire        access_write,
  input  wire        access_prefetch,
  output wire [1:0]  victim_way,
  output wire        prefetch_valid,
  output wire [31:0] prefetch_addr,
  input  wire        prefetch_ready
);
  reg [7:0] age [0:63];          // four 2-bit ages per set, way w at bits [2w+1:2w]

  wire [7:0] cur = age[access_set];
  wire [1:0] a0 = cur[1:0], a1 = cur[3:2], a2 = cur[5:4], a3 = cur[7:6];

  // The way at age 3 is the victim.
  assign victim_way = (a0 == 2'd3) ? 2'd0 : (a1 == 2'd3) ? 2'd1 : (a2 == 2'd3) ? 2'd2 : 2'd3;

  wire [1:0] touched = access_hit ? access_way : victim_way;
  wire [1:0] tage = (touched == 2'd0) ? a0 : (touched == 2'd1) ? a1 : (touched == 2'd2) ? a2 : a3;

  function [1:0] bump;
    input [1:0] a; input [1:0] limit; input is_touched;
    begin
      if (is_touched) bump = 2'd0;
      else if (a < limit) bump = a + 2'd1;
      else bump = a;
    end
  endfunction

  wire [7:0] nxt = { bump(a3, tage, touched == 2'd3), bump(a2, tage, touched == 2'd2),
                     bump(a1, tage, touched == 2'd1), bump(a0, tage, touched == 2'd0) };

  integer i;
  always @(posedge clk) begin
    if (!rst_n) begin
      for (i = 0; i < 64; i = i + 1) age[i] <= 8'b00_01_10_11;
    end else if (access_valid) begin
      age[access_set] <= nxt;
    end
  end

  assign prefetch_valid = 1'b0;
  assign prefetch_addr = 32'd0;
endmodule
