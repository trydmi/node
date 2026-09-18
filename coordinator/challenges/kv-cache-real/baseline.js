/**
 * Baseline policy: plain LRU over content-addressed KV blocks, O(1) per access with a doubly linked list.
 * CommonJS on purpose: evaluated as source inside a VM.
 */
module.exports = function createPolicy() {
  const nodes = new Map()
  const head = { prev: null, next: null }, tail = { prev: null, next: null }
  head.next = tail; tail.prev = head
  const unlink = (n) => { n.prev.next = n.next; n.next.prev = n.prev }
  const pushBack = (n) => { n.prev = tail.prev; n.next = tail; tail.prev.next = n; tail.prev = n }
  return {
    onRequest() {},
    onAccess(key) {
      let n = nodes.get(key)
      if (n) unlink(n); else { n = { key, prev: null, next: null }; nodes.set(key, n) }
      pushBack(n)
    },
    onEvict(key) { const n = nodes.get(key); if (n) { unlink(n); nodes.delete(key) } },
    victim() { return head.next.key },
  }
}
