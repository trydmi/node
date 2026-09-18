# compression-corpus: lossless compression of a hidden corpus

**Level:** L2 (no simulator, no toolchain). **Objective:** `compressedBytes`, lower is better.
**Time budget:** 60 s of CPU per corpus, compression and decompression together.
**Tools:** none. Any node in the network can score this one.

## What the challenge is

Compression is the cleanest test of a model there is. Every byte you save is a byte of structure you found,
and the score cannot be argued with: either the bytes come back or they do not.

The submission is a codec. The harness hands it twenty documents and counts what comes out. Then it builds a
second, independent copy of the same codec and makes it reproduce every document byte for byte from those
bytes alone. Round trip first, size second.

## Objective

```
compressedBytes = the compressed payload over the whole corpus + the byte length of the submitted source
```

Lower is better. The source counts because the source is part of the encoding. A table baked into the
artifact is bytes the decoder needs, exactly like bytes in the payload, and a rule that counted one and not
the other would pay for moving data from the stream into the source. Comments and whitespace count too: any
rule that skipped them could be used to smuggle a table through them. The artifact is capped at 64 KB, so the
cap is a ceiling and the counting is the real constraint.

That also settles the embedding question. Baking the corpus into the artifact is impossible twice over: 2 MB
does not fit in 64 KB, the bytes would cost what they weigh, and the score is on a hidden corpus the public
one does not contain.

Correctness comes first. If any document does not decompress to the original bytes, the submission is invalid
and its size is never scored. A smaller wrong answer scores nothing.

## The corpus

Generated, not vendored. `gen-corpus.mjs` builds the whole corpus from one number, which means it is
reproducible anywhere, it carries no third-party license, and the hidden corpus is the same generator on
another seed. The public corpus is seed 1, twenty documents, 2,004,048 bytes.

Five kinds, four documents each, about 100 KB apiece:

| Kind | What it is | What it rewards |
| --- | --- | --- |
| `prose` | English-shaped sentences from a Zipf vocabulary, with a table of phrases that repeat | word and letter context, a match model |
| `jsonl` | one log record per line: fixed key order, monotonic timestamps, bounded value sets | column-aware context, modelling a field by its position in the line |
| `csv` | a numeric table: an id that counts up, columns that random-walk, small categorical columns | delta coding, one context per column |
| `code` | source-shaped text: indentation, nesting, a small identifier set reused | long contexts, indentation as state |
| `records` | raw binary: fixed 24-byte records, little-endian counters, deltas, zero padding | a fixed period, byte position within the record |

Everything the seed decides is re-rolled on the hidden corpus: the vocabulary, the phrase table, the service
and route names, the CSV column names, the code identifiers, the enum values, the epoch, and the order the
documents come in. So a codec that hardcodes words lifted from the public corpus gains nothing where it
counts, and a codec that models structure gains on both. That is the split the challenge is built to reward.

## What a submission is

One CommonJS module. It is JavaScript because the whole thing needs no compiler and no image: it runs in the
same locked-down worker the KV-cache challenges use, on every node in the network, with no toolchain to pin
and no version of anything to disagree about.

```js
module.exports = function createCodec() {
  return {
    compress(input) { /* input is a Uint8Array, return a Uint8Array */ },
    decompress(input) { /* input is what compress returned, return the original bytes */ },
  }
}
```

The harness:

1. builds one instance and calls `compress` on every document in order, keeping a copy of each output
2. builds a second instance in a **fresh context** and calls `decompress` on those outputs, in the same order
3. compares every result with the original bytes and totals the sizes

One instance sees the whole corpus, so a codec may carry a model from one document to the next. Both the
baseline and the example do. Resetting the baseline's table at the start of every document costs it 2.4
percent (859,930 bytes instead of 838,944), so it is worth taking. The two instances share nothing: no globals, no
closures, no disk, no clock. Everything the decoder knows has to be in the bytes the encoder returned or in
the source itself.

Compression gets a private copy of every document, so a codec that writes into its input cannot corrupt what
the round trip is checked against. Every compressed output is copied into a plain byte array before the
decoder sees it, which strips object identity and any extra properties, so the array itself carries nothing
but its bytes.

## Rules

Checked before anything is compressed. Breaking one is an invalid submission with a message that says which
rule.

- At most 64 KB of source, and every byte of it counts toward the score.
- `module.exports` is a factory function. It must return an object with `compress` and `decompress`.
- Both take a `Uint8Array` and must return a `Uint8Array`. A string, a plain array or a wider typed array is
  rejected. An output more than four times the size of its input is rejected rather than allocated.
- No `require`, no I/O, no timers. The VM has none of them.
- `Math.random` and `Date.now` are replaced with functions that throw. A codec must be deterministic: two
  runs of the same source have to produce the same bytes, and the coordinator reruns every improvement in a
  second process and compares a fingerprint of the compressed output.
- These identifiers are refused in the source: `constructor`, `__proto__`, `prototype`, `process`, `require`,
  `import`, `Function`, `eval`, `globalThis`, `Reflect`, `Proxy`, `WebAssembly`, `Atomics`,
  `SharedArrayBuffer`, `arguments.callee`. None of them are needed by a codec and every known escape from the
  VM goes through one of them.
- 60,000 ms of CPU for the whole corpus, compression and decompression together.

A note on determinism, because it is easy to lose a score to it: `Math.exp` and `Math.log` are allowed to
differ between engine builds, so a probability computed with either can differ between two nodes, and two
honest nodes that disagree do not promote anything. Integer tables and plain `+`, `-`, `*`, `/` on doubles are
exact in JavaScript, and the example uses only those.

## Measured numbers (Apple silicon laptop, Node 23, 2026-09-08)

| Codec | Public corpus | Hidden corpus | CPU (compress plus decompress) |
| --- | --- | --- | --- |
| `baseline.js`, order-1 arithmetic coder | 838,944 | 842,423 | 2.9 s |
| `examples/compression-context-mixing.js` | 438,523 (47.73% better) | 437,122 (48.11% better) | 17.5 s |

Both totals include the artifact's own bytes: 3,924 for the baseline and 7,792 for the example. The public
corpus is 2,004,048 bytes, so the baseline is 3.35 bits per byte and the example 1.75.

The two corpora give nearly the same number, which is the point of re-rolling the vocabulary rather than the
structure. A codec that scored well on the public corpus and badly on the hidden one would have learned the
words instead of the shape.

### Reference points on the same public corpus

Real compressors, run over the twenty documents concatenated into one stream, so they get the same
cross-document redundancy the codec does:

| | One solid stream | Per document, summed |
| --- | --- | --- |
| `gzip -9` | 573,202 | 571,561 |
| `zstd -19` | 431,447 | 490,359 |
| `brotli -q 11` | 407,996 | 445,054 |
| `xz -9e` | 382,192 | 438,072 |

(zstd 1.5.7, xz 5.8.2, brotli 1.2.0.) The example lands next to `zstd -19` and `xz -9e` is still ahead of it,
mostly on the binary records, where a match model beats a bag of byte contexts. That gap is the headroom.

## Directions worth trying

- Context mixing over several orders, which is what the example does, then more models and a better mixer
- A match model: find the longest recent context that matches and predict the byte that followed it. This is
  where `xz` beats the example, and it is the biggest single win available on `records` and `jsonl`
- Modelling the numeric columns as deltas rather than as characters
- A secondary estimation stage (SSE or APM) on the mixed probability
- Detecting the record period in the binary documents and using position within the record as context
- Carrying more than the model across documents: the vocabulary the earlier documents taught you

## Running it locally

```bash
node coordinator/challenges/compression-corpus/gen-corpus.mjs --seed 1 --out /tmp/public-corpus.json.gz
node coordinator/challenges/compression-corpus/harness.js coordinator/challenges/compression-corpus/baseline.js
node coordinator/challenges/compression-corpus/harness.js examples/compression-context-mixing.js
```

With no corpus argument the harness reads `public-corpus.json.gz` from its own directory, which is where
`ensureTraces()` writes it. The verdict is JSON: `compressedBytes`, the payload and source halves, bits per
byte, a breakdown by document and by kind, and the fingerprint. `node --test test/compression.test.mjs` runs
the challenge tests in about 9 s and needs nothing installed.

## Provenance

The corpus comes from `gen-corpus.mjs` in this directory and is deterministic from its seed. Nothing is
vendored and no third-party data is redistributed, so there is no license on the corpus beyond this
repository's own. The reference numbers above were measured with zstd 1.5.7, xz 5.8.2 and brotli 1.2.0.
