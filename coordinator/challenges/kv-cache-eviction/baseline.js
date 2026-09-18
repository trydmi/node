/**
 * Baseline policy: plain LRU over KV-cache blocks.
 * Shipped to participants as the bar to beat. CommonJS on purpose: the
 * harness evaluates policies as CommonJS source inside a VM.
 */
module.exports = function createPolicy() {
  let clock = 0
  const lastUsed = new Map()
  return {
    onAccess(key) {
      lastUsed.set(key, ++clock)
    },
    onEvent() {},
    onEvict(key) {
      lastUsed.delete(key)
    },
    victim(residentKeys) {
      let best = residentKeys[0]
      let bestT = Infinity
      for (const k of residentKeys) {
        const t = lastUsed.get(k) ?? -1
        if (t < bestT) {
          bestT = t
          best = k
        }
      }
      return best
    },
  }
}
