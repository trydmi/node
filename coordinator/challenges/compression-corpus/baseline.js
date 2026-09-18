/**
 * Baseline codec for compression-corpus: an order-1 binary arithmetic coder.
 *
 * The obvious first thing that is not a library. Every byte is coded as eight binary decisions. The context
 * for each decision is the previous whole byte plus the bits of the current byte decoded so far, so the model
 * is a table of 65,536 adaptive probabilities, twelve bits each. The coder is the carryless binary arithmetic
 * coder used by the lpaq family: two 32-bit bounds, a byte shifted out whenever the top bytes agree.
 *
 * Each document gets a four-byte length header and its own coder. The model table is NOT reset between
 * documents: one compressor instance sees the whole corpus in order, and the harness gives the decompressor a
 * second instance that sees the compressed documents in the same order, so both sides walk the same states.
 * That is free redundancy across twenty documents and the baseline takes it.
 *
 * What it leaves on the table: one context, no match model, no mixing, no preprocessing of the numeric
 * columns or the fixed-width binary records.
 */
module.exports = function createCodec() {
  var CTX = 1 << 16
  var RATE = 5

  // ---- output buffer: a growing byte array, closures only ------------------
  function makeOut(cap) {
    var buf = new Uint8Array(cap > 64 ? cap : 64)
    var n = 0
    return {
      put: function (b) {
        if (n === buf.length) { var bigger = new Uint8Array(buf.length * 2); bigger.set(buf); buf = bigger }
        buf[n++] = b & 0xff
      },
      done: function () { return buf.subarray(0, n) },
    }
  }

  // ---- the model: one adaptive probability per (previous byte, partial byte) ----
  var t = new Uint16Array(CTX)
  for (var i = 0; i < CTX; i++) t[i] = 2048

  // ---- shared state across documents --------------------------------------
  var prev = 0

  function clamp(p) { return p < 1 ? 1 : p > 4095 ? 4095 : p }

  function compress(input) {
    var out = makeOut((input.length >> 1) + 64)
    var n = input.length
    out.put((n >>> 24) & 0xff); out.put((n >>> 16) & 0xff); out.put((n >>> 8) & 0xff); out.put(n & 0xff)
    var x1 = 0, x2 = 4294967295
    for (var i = 0; i < n; i++) {
      var byte = input[i]
      var c = 1
      for (var b = 7; b >= 0; b--) {
        var bit = (byte >>> b) & 1
        var idx = ((prev << 8) | c) & (CTX - 1)
        var p = clamp(t[idx])
        var xmid = x1 + Math.floor((x2 - x1) / 4096) * p
        if (bit) x2 = xmid; else x1 = xmid + 1
        while (((x1 ^ x2) & 0xff000000) === 0) {
          out.put(x2 >>> 24)
          x1 = (x1 << 8) >>> 0
          x2 = ((x2 << 8) | 255) >>> 0
        }
        t[idx] = t[idx] + (((bit << 12) - t[idx]) >> RATE)
        c = (c << 1) | bit
      }
      prev = byte
    }
    out.put((x1 >>> 24) & 0xff); out.put((x1 >>> 16) & 0xff); out.put((x1 >>> 8) & 0xff); out.put(x1 & 0xff)
    return out.done()
  }

  function decompress(input) {
    var n = ((input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3]) >>> 0
    var out = new Uint8Array(n)
    var pos = 4
    var next = function () { return pos < input.length ? input[pos++] : 0 }
    var x1 = 0, x2 = 4294967295
    var x = ((next() << 24) | (next() << 16) | (next() << 8) | next()) >>> 0
    for (var i = 0; i < n; i++) {
      var c = 1
      for (var b = 0; b < 8; b++) {
        var idx = ((prev << 8) | c) & (CTX - 1)
        var p = clamp(t[idx])
        var xmid = x1 + Math.floor((x2 - x1) / 4096) * p
        var bit = x <= xmid ? 1 : 0
        if (bit) x2 = xmid; else x1 = xmid + 1
        while (((x1 ^ x2) & 0xff000000) === 0) {
          x1 = (x1 << 8) >>> 0
          x2 = ((x2 << 8) | 255) >>> 0
          x = ((x << 8) | next()) >>> 0
        }
        t[idx] = t[idx] + (((bit << 12) - t[idx]) >> RATE)
        c = (c << 1) | bit
      }
      out[i] = c & 0xff
      prev = out[i]
    }
    return out
  }

  return { compress: compress, decompress: decompress }
}
