// DMI rtl-synth-fifo baseline: a plain 32-entry, 32-bit synchronous FIFO with a running CRC-8 over every accepted
// push. Binary read and write pointers, a 6-bit occupancy count, show-ahead output (dout is the head word whenever
// the FIFO is not empty), and a CRC that runs the bit-serial polynomial division four bytes deep in one cycle.
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
  reg [31:0] mem [0:31];
  reg [4:0]  wr_ptr, rd_ptr;
  reg [5:0]  cnt;
  reg [7:0]  crc_r;

  assign full         = (cnt == 6'd32);
  assign empty        = (cnt == 6'd0);
  assign almost_full  = (cnt >= 6'd28);
  assign almost_empty = (cnt <= 6'd4);
  assign count        = cnt;
  assign crc          = crc_r;
  assign dout         = mem[rd_ptr];

  wire do_push = push && !full;
  wire do_pop  = pop && !empty;

  // CRC-8, polynomial x^8 + x^2 + x + 1 (0x07), no reflection, init 0, one byte at a time, bit by bit.
  function [7:0] crc8_byte;
    input [7:0] c;
    input [7:0] b;
    integer k;
    reg [7:0] t;
    begin
      t = c ^ b;
      for (k = 0; k < 8; k = k + 1) t = t[7] ? {t[6:0], 1'b0} ^ 8'h07 : {t[6:0], 1'b0};
      crc8_byte = t;
    end
  endfunction

  wire [7:0] crc_next = crc8_byte(crc8_byte(crc8_byte(crc8_byte(crc_r, din[31:24]), din[23:16]), din[15:8]), din[7:0]);

  always @(posedge clk) begin
    if (!rst_n) begin
      wr_ptr <= 5'd0;
      rd_ptr <= 5'd0;
      cnt    <= 6'd0;
      crc_r  <= 8'h00;
    end else begin
      if (do_push) begin
        mem[wr_ptr] <= din;
        wr_ptr <= wr_ptr + 5'd1;
        crc_r  <= crc_next;
      end
      if (do_pop) rd_ptr <= rd_ptr + 5'd1;
      if (do_push && !do_pop) cnt <= cnt + 6'd1;
      else if (do_pop && !do_push) cnt <= cnt - 6'd1;
    end
  end
endmodule
