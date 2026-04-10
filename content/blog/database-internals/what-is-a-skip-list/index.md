---
title: "The Probabilistic Gamble:<br>Why Redis Bets Your Data on a Coin Flip"
subtitle: "Every sorted set in Redis is backed by a data structure that decides its own shape by flipping coins. It should not work this well. Here is why it does."
date: 2026-04-05
author: "Imloul Anas"
tags: ["skip-list", "probabilistic", "redis", "sorted-sets"]
draft: true
math: true
---

If you ever trace how `ZADD` works in Redis, follow the call stack into the sorted set implementation, you expect to land on a balanced tree or some well-known variant. What you find instead is a function called `zslInsert` with a loop that calls `random()` to decide how tall to build each new node.

Redis. The database that half the internet runs on. Deciding the shape of its index with a random number generator.

My first reaction was that I'd misread something. Then that it must be isolated to some edge case. But the more I dug, the clearer it became: this was deliberate. Not a shortcut, a tradeoff. One that gives up the deterministic guarantees of a balanced tree in exchange for simpler code, better cache behavior, and concurrency that scales well under real load.

That structure is the **skip list**. And it's worth understanding properly.

---

{{< section-label >}}The Problem{{< /section-label >}}

## What a Sorted Index Actually Needs to Do

Redis sorted sets (`ZSET`) are not a simple key-value store. They are a fully ordered index that must support all of these efficiently:

- Insert a member with a score: `ZADD leaderboard 4200 "alice"`
- Delete a member by name: `ZREM leaderboard "alice"`
- Look up a member's rank: `ZRANK leaderboard "alice"`
- Retrieve members in a score range: `ZRANGEBYSCORE leaderboard 1000 5000`
- Retrieve members by rank range: `ZRANGE leaderboard 0 99`

The combination is the hard part. A sorted array handles range scans but needs $O(n)$ to insert. A hash map gives $O(1)$ lookup but has no ordering. A binary heap inserts in $O(\log n)$ but can't do range queries without scanning everything.

You need $O(\log n)$ point operations *and* $O(\log n + k)$ range scans (where $k$ is the number of results returned). The textbook answer is a balanced binary search tree: a red-black tree, an AVL tree, or a B-tree. These work, but they carry costs that matter in Redis's context, and those costs are what the skip list was designed to avoid.

---

{{< section-label >}}The Classical Answer{{< /section-label >}}

## What Balanced Trees Get Right, and What They Get Wrong

A red-black tree gives you everything the sorted set needs. Insertion, deletion, and search are all $O(\log n)$. In-order traversal gives you range scans in $O(\log n + k)$. It is the answer used by many databases and standard libraries.

So why doesn't Redis use one?

The algorithmic complexity is essentially the same. The difference is in implementation complexity, memory layout, and concurrency.

{{< definition icon="RBT" term="Red-Black Tree" >}}
A self-balancing binary search tree that guarantees $O(\log n)$ operations by enforcing structural rules after every insert and delete. Correct, but hard to implement and harder to make concurrent. [Wikipedia](https://en.wikipedia.org/wiki/Red%E2%80%93black_tree)
{{< /definition >}}

{{< diagram src="redblacktree" caption="Red–black tree at a glance: a binary search tree whose nodes are colored red or black so the tree stays approximately balanced (same black-node count on every path from the root, no two consecutive reds, and similar rules). Dark nodes are black, bright nodes are red. For the full invariant list and history, see the Wikipedia article linked in the definition above." >}}

When you insert into a red-black tree, the rotations and recoloring can touch nodes far from the insertion point, sometimes cascading all the way to the root. To insert safely under concurrency, you either lock the entire tree (serializing all writes) or implement a complex lock-coupling protocol. Most implementations take the easy path and use a coarse-grained lock.

{{< callout title="The concurrency problem is not theoretical" type="error" >}}
Redis itself is single-threaded for command processing, so it sidesteps this directly. But the lesson generalizes: systems like LevelDB, RocksDB, and many in-memory databases that need concurrent writes have found balanced trees painful to make lock-free. The skip list has a natural concurrent variant that only locks a small, bounded set of nodes per operation.
{{< /callout >}}

There is a second problem: memory access patterns. A red-black tree node holds left, right, and parent pointers, a color bit, and the key, roughly 40 bytes of overhead on a 64-bit system. Worse, nodes are individually heap-allocated and scattered across memory. A traversal that visits 20 nodes likely incurs 20 cache misses. Each pointer dereference lands on a different cache line (the 64-byte chunk of memory the CPU fetches in one shot), so following a pointer often means waiting for a fresh memory fetch.

The skip list does not fully solve this, but its structure makes cache behavior more predictable in practice.

---

{{< section-label >}}The Invention{{< /section-label >}}

## William Pugh's Insight: Approximate Balance Is Enough

The skip list comes from a 1990 paper by William Pugh, ["Skip Lists: A Probabilistic Alternative to Balanced Trees."](https://15721.courses.cs.cmu.edu/spring2018/papers/08-oltpindexes1/pugh-skiplists-cacm1990.pdf) The core idea: you don't need to guarantee balance. You just need to make imbalance astronomically unlikely.

Start with a sorted linked list. Search is $O(n)$, you walk forward until you find your key. Too slow. But add a second, sparser layer on top, a "fast lane" that skips over roughly half the nodes. Scan the fast lane until you overshoot, drop down, scan the last few nodes. Two layers cut search time roughly in half.

Now add a third layer that skips half the second. And a fourth. If each layer skips half the nodes below it, you get something that behaves like binary search: each layer halves the search space, giving $O(\log n)$ expected time.

{{< definition icon="SL" term="Skip List" >}}
A probabilistic data structure built as a hierarchy of sorted linked lists. The bottom layer (level 0) contains every element. Each higher layer contains a random subset of the layer below, where each element is independently promoted with probability p (typically 0.25 or 0.5). Searches descend through the layers, using higher layers to skip large portions and lower layers to refine the position.
{{< /definition >}}

The word "random" is doing critical work here. A balanced tree forces balance through explicit rotations after every insert or delete. A skip list achieves approximate balance by having each node decide its own height with a biased coin flip (a random draw where the probability of "heads" is p, not necessarily 50/50). No rebalancing is ever needed. The randomness guarantees that, with high probability, the height distribution across the structure approximates what a perfectly balanced tree would look like.

{{< callout title="What 'with high probability' actually means" type="info" >}}
For a skip list with $n$ elements and promotion probability $p = 0.5$, the probability that the maximum height exceeds $3\log_2 n$ is at most $1/n$. With one million elements, the chance of pathological height is less than one in a million per operation. In practice, skip lists handle billions of operations in production without ever hitting worst-case behavior.
{{< /callout >}}

---

{{< section-label >}}The Anatomy{{< /section-label >}}

## Inside a Skip List Node

Instead of left and right child pointers, each skip list node contains a **tower** of forward pointers, one per level it participates in. A node at level 3 has three forward pointers: one for each level, each pointing to the next node at that level.

{{< diagram src="skiplist" caption="Skip List: the bottom layer contains every element. Each higher layer is a probabilistic subset of the layer below. Searches use higher layers to skip large portions of the list, dropping down as they approach the target." >}}

Searching for 42: start at the top level of the head node. At level 3, the next node is 42, done. Searching for 55: advance to 42 at level 3, next is NULL, drop to level 2, next is 61 (overshoots), drop to level 1, 61 again, drop to level 0, find 55. The higher levels act as an express lane, skipping large chunks of the list in a single pointer jump.

{{< definition icon="FP" term="Forward Pointer Array" >}}
Each skip list node stores an array of next-pointers, one per level. A node at height h has h forward pointers. With $p = 0.25$, the expected number of forward pointers per node is $1/(1-0.25) = 1.33$, so the average node is only slightly larger than a regular linked list node.
{{< /definition >}}

---

{{< section-label >}}The Operations{{< /section-label >}}

## Search, Insert, and Delete: How the Coin Flip Fits In

### Search

Start at the top level of the head node. At each level, advance forward while the next node's key is less than the target. When advancing would overshoot, drop one level. At level 0, the next node is either your target or it doesn't exist. Expected comparisons: $O(\log n)$, each level roughly halves the search space.

{{< codeblock label="Search" labeltype="neutral" lang="go" >}}
func search(list *SkipList, target int) *Node {
  node := list.head
  for level := list.maxLevel; level >= 0; level-- {
    for node.next[level] != nil && node.next[level].key < target {
      node = node.next[level] // advance along this level
    }
    // overshoots: drop down
  }
  node = node.next[0]
  if node != nil && node.key == target {
    return node
  }
  return nil // not found
}
{{< /codeblock >}}

### Insert

Insert starts with a search, but along the way it records the last node visited at each level in an `update` array: a list of predecessors, one per level, whose forward pointers will need to be rewired to include the new node.

Then the coin flip. The new node's height is chosen by repeatedly flipping a biased coin (probability p): each heads promotes it one level higher, each tails stops. The expected height follows from the geometric series:

$$E[\text{height}] = \sum_{k=0}^{\infty} p^k = \frac{1}{1-p}$$

With $p = 0.25$, that's $\frac{1}{0.75} \approx 1.33$ levels on average.

The new node is then spliced in at every level up to its height, using the `update` array to rewire the forward pointers. No rotations. No recoloring. No cascade. The insert touches only the nodes in the `update` array.

{{< codeblock label="Insert" labeltype="neutral" lang="go" >}}
func insert(list *SkipList, key int, value string) {
  update := make([]*Node, list.maxLevel+1) // rightmost node visited at each level
  node := list.head
  for level := list.maxLevel; level >= 0; level-- {
    for node.next[level] != nil && node.next[level].key < key {
      node = node.next[level]
    }
    update[level] = node // record the predecessor at this level
  }

  height := coinFlip(list.p) // coin flip determines how many levels to occupy
  newNode := &Node{key: key, value: value, next: make([]*Node, height+1)}

  for level := 0; level <= height; level++ {
    newNode.next[level] = update[level].next[level] // splice in
    update[level].next[level] = newNode
  }
}
{{< /codeblock >}}

{{< callout title="Why the update array matters" type="info" >}}
The update array has at most $O(\log n)$ entries, one per level. The number of nodes modified by any insert is logarithmic and known in advance. This bounded footprint is what makes skip lists easy to lock correctly under concurrency: lock exactly the update array nodes, nothing else.
{{< /callout >}}

### Delete

Delete mirrors insert. Search for the target, populate the `update` array, then bypass the target's forward pointers at every level. The node becomes unreachable and can be freed.

No rebalancing needed. The remaining nodes' random heights still produce a probabilistically balanced structure.

{{< codeblock label="Delete" labeltype="neutral" lang="go" >}}
func delete(list *SkipList, key int) bool {
  update := make([]*Node, list.maxLevel+1)
  node := list.head
  for level := list.maxLevel; level >= 0; level-- {
    for node.next[level] != nil && node.next[level].key < key {
      node = node.next[level]
    }
    update[level] = node // record the predecessor at each level
  }

  target := node.next[0]
  if target == nil || target.key != key {
    return false // key does not exist
  }

  for level := 0; level < len(target.next); level++ {
    update[level].next[level] = target.next[level] // bypass the target node
  }
  return true // target is now unreachable and can be freed
}
{{< /codeblock >}}

---

{{< section-label >}}The Redis Implementation{{< /section-label >}}

## How Redis Actually Uses It

Redis doesn't use a skip list for every sorted set. Small ones (under 128 members by default, or members exceeding 64 bytes) use a **listpack**, a compact encoding that stores everything sequentially in contiguous memory. Faster to scan, less memory.

Once a sorted set grows past that threshold, Redis automatically converts it in place to the skip list structure, transparently, on the write that crosses the limit.

{{< definition icon="ZS" term="Redis zskiplist" >}}
Redis's skip list implementation, defined in `t_zset.c`. Each node stores the member string, its floating-point score, and a backward pointer for reverse traversal, alongside the forward pointer array. Sorted primarily by score, secondarily by lexicographic order of the member string, so two members with identical scores still have a stable, deterministic ordering.
{{< /definition >}}

{{< definition icon="ZD" term="Redis zset (the dual structure)" >}}
Above the listpack threshold, a sorted set is two structures in parallel: a skip list for ordered traversal and range queries, and a hash table mapping member strings to scores for $O(1)$ lookup. Every `ZADD` writes to both. Every `ZREM` removes from both.
{{< /definition >}}

The skip list answers "give me the top 100 by score." The hash table answers "what is alice's score?" Neither alone handles both efficiently, so Redis maintains both and pays the memory cost.

{{< callout title="Why Redis uses p = 0.25" type="info" >}}
Most examples use p = 0.5, but Redis uses 0.25. This produces shorter nodes on average, saving memory on the forward pointer arrays. The tradeoff is slightly more comparisons per search (sparser upper levels), but for millions of members the memory savings win. The maximum level is capped at 64, enough for 2^64 elements.
{{< /callout >}}

---

{{< section-label >}}The Complexity{{< /section-label >}}

## The Numbers, Side by Side

With the structure understood, here's how it compares:

<table class="compare-table">
  <thead>
    <tr>
      <th>Operation</th>
      <th>Sorted Array</th>
      <th>Red-Black Tree</th>
      <th>Skip List</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Search</td>
      <td><span class="tag good">$O(\log n)$</span></td>
      <td><span class="tag good">$O(\log n)$</span></td>
      <td><span class="tag good">$O(\log n)$ expected</span></td>
    </tr>
    <tr>
      <td>Insert</td>
      <td><span class="tag bad">$O(n)$</span></td>
      <td><span class="tag good">$O(\log n)$</span></td>
      <td><span class="tag good">$O(\log n)$ expected</span></td>
    </tr>
    <tr>
      <td>Delete</td>
      <td><span class="tag bad">$O(n)$</span></td>
      <td><span class="tag good">$O(\log n)$</span></td>
      <td><span class="tag good">$O(\log n)$ expected</span></td>
    </tr>
    <tr>
      <td>Range scan</td>
      <td><span class="tag good">$O(\log n + k)$</span></td>
      <td><span class="tag good">$O(\log n + k)$</span></td>
      <td><span class="tag good">$O(\log n + k)$ expected</span></td>
    </tr>
    <tr>
      <td>Rank lookup</td>
      <td><span class="tag good">$O(\log n)$</span></td>
      <td><span class="tag good">$O(\log n)$ with augmentation</span></td>
      <td><span class="tag good">$O(\log n)$ with span augmentation</span></td>
    </tr>
    <tr>
      <td>Concurrent insert</td>
      <td><span class="tag bad">Full lock required</span></td>
      <td><span class="tag bad">Complex lock coupling</span></td>
      <td><span class="tag good">Lock only update array nodes</span></td>
    </tr>
    <tr>
      <td>Implementation complexity</td>
      <td><span class="tag good">Low</span></td>
      <td><span class="tag bad">High</span></td>
      <td><span class="tag good">Low</span></td>
    </tr>
  </tbody>
</table>

The "expected" qualifier is the honest difference. A red-black tree guarantees $O(\log n)$ worst case. A skip list guarantees it in expectation: the probability of exceeding it decays exponentially, but it's not zero. For most production workloads, this is irrelevant. For hard real-time systems with strict latency bounds, it matters.

---

{{< section-label >}}The Rank Trick{{< /section-label >}}

## How Redis Answers ZRANK in $O(\log n)$

A plain skip list can tell you whether a key exists, but not its rank (ordinal position) without scanning the entire base layer. Redis solves this by adding a **span** value to every forward pointer.

{{< definition icon="SP" term="Span" >}}
An integer on each forward pointer recording how many base-layer nodes it skips over. A level-2 pointer jumping from A to C, skipping B1 and B2, has a span of 3. By summing spans along the search path, Redis gets the exact rank without touching the nodes in between.
{{< /definition >}}

Spans are maintained during inserts and deletes by adjusting values in the `update` array, adding only a constant factor to those operations.

The result: `ZRANK` runs in $O(\log n)$ with no extra data structure and no base-layer scan. It's a clean example of augmenting a traversal structure with per-node metadata to unlock a new query type at minimal cost.

{{< callout title="Connection to Order Statistics Trees" type="info" >}}
If you're familiar with augmented BSTs: span augmentation is conceptually identical to subtree counts in an Order Statistics Tree. Both record "how many elements are behind this pointer" to answer rank queries in $O(\log n)$. The practical difference is update cost. In an OST, count updates cascade to the root on every insert. In the skip list, span updates are confined to the update array nodes, which were already being modified anyway, so there's no extra traversal cost.
{{< /callout >}}

---

{{< section-label >}}Concurrency{{< /section-label >}}

## Why Skip Lists Scale Under Concurrent Writes

This is where skip lists most clearly win in practice.

Remember the update array: the only nodes whose pointers change during an insert. In a concurrent setting, you lock exactly those nodes, splice in the new node, and release. Two inserts into different parts of the list touch disjoint update arrays and proceed in parallel without contention.

This is **localized modification**. Compare it to a red-black tree, where a rotation at a leaf can cascade upward through ancestors that are shared by every traversal in the tree.

{{< pillars >}}
{{< pillar num="01" title="Localized Modification" >}}
The update array has at most $O(\log n)$ entries, all identified during the search phase before any locks are acquired. Simple, predictable locking.
{{< /pillar >}}
{{< pillar num="02" title="No Rebalancing Cascade" >}}
No operation triggers unbounded structural changes. The worst case for any insert or delete is bounded by the node's height, which is logarithmic with high probability.
{{< /pillar >}}
{{< pillar num="03" title="Lock-Free Variants" >}}
The bounded modification footprint enables lock-free implementations using compare-and-swap, a CPU instruction that atomically updates a pointer only if it still holds an expected value. Java's `ConcurrentSkipListMap` uses this approach, achieving near-linear throughput scaling with thread count.
{{< /pillar >}}
{{< /pillars >}}

---

{{< section-label >}}Memory Layout{{< /section-label >}}

## The Cache Behavior of a Skip List

A fair criticism of skip lists: variable-height nodes with individually allocated pointer arrays are harder to lay out in memory than fixed-size tree nodes. On 10 million members, the overhead is measurable.

But this misses an access pattern advantage. The higher levels act as an increasingly coarse index. The top few levels are touched on virtually every operation and stay hot in CPU cache. With p = 0.25, level-3 nodes appear at roughly 1.5% of positions. A 10-million-element dataset has about 150,000 level-3 nodes, small enough to sit comfortably in L3 cache under sustained load.

{{< callout title="The upper levels behave like a cache-resident index" type="info" >}}
Just as the upper levels of a B-tree tend to stay in the database's page cache because they're accessed on every query, the upper levels of a skip list tend to stay in CPU cache because they're visited on every search. The probabilistic structure accidentally recreates the locality properties of a deliberately designed hierarchical index.
{{< /callout >}}

---

{{< section-label >}}Where Skip Lists Are Used{{< /section-label >}}

## Beyond Redis: Where This Structure Appears

Redis is the most visible user, but skip lists show up in more places than you'd expect.

**LevelDB and RocksDB** use a skip list as their in-memory write buffer (MemTable). Writes land in the skip list first, queryable immediately, then flush to disk as SSTables. It supports point lookups, range scans, fast inserts, and sorted iteration for flushing. RocksDB uses a lock-free variant for concurrent access.

**Apache Lucene** uses skip lists inside inverted index posting lists to speed up boolean query evaluation. When intersecting or unioning posting lists, skip pointers let the merge algorithm jump forward over irrelevant entries.

**Java's ConcurrentSkipListMap** is the standard library's concurrent sorted map, a lock-free implementation that avoids the serialization cost of synchronized wrappers.

{{< callout title="A pattern worth noticing" type="info" >}}
In every case, the skip list is chosen not for better asymptotic complexity (it's the same) but because it is simpler to implement correctly under concurrency. The randomness that feels unprincipled is exactly what eliminates the rebalancing logic that makes concurrent balanced trees so hard to get right.
{{< /callout >}}

---

{{< section-label >}}The Honest Trade-offs{{< /section-label >}}

## What the Skip List Gives Up

Three genuine tradeoffs worth knowing.

**Worst-case complexity is probabilistic, not guaranteed.** A red-black tree guarantees $O(\log n)$ for every operation. A skip list guarantees it in expectation. For most workloads, this is academic. For hard real-time systems or financial matching engines with strict SLA requirements, the deterministic guarantee may matter.

**Memory overhead is higher.** A height-4 node has 4 forward pointers plus backward pointer, score, and member pointer: ~56 bytes of overhead. A red-black tree node is ~32 bytes. With p = 0.25, the average overhead per node is about 10.7 bytes (competitive), but tall outlier nodes are substantially larger.

**No on-disk variant.** The skip list is an in-memory structure. Variable-length nodes and pointer-heavy layout make it unsuitable for disk storage. This is why LevelDB uses skip lists for its in-memory MemTable but B-trees (via SSTables) for the on-disk component.

---

{{< section-label >}}Putting It Together{{< /section-label >}}

## What This Means for the Redis Commands You Use

Now you can reason about the performance of the commands you already use.

**`ZADD` and `ZREM` are $O(\log n)$.** Descend the skip list, populate the update array, splice, update spans. At a million members, roughly 20 pointer comparisons.

**`ZRANGE` and `ZRANGEBYSCORE` are $O(\log n + k)$.** Descend to the start position in $O(\log n)$, then walk the base layer forward for $k$ results. The base-layer walk is sequential pointer chasing, cache-friendly.

**`ZRANK` is $O(\log n)$ thanks to span augmentation.** Without spans, this would be an $O(n)$ base-layer scan. The span values accumulated during descent give the exact rank as a byproduct.

{{< codeblock label="Efficient: $O(\log n + k)$ range scan" labeltype="good" lang="bash" complexity="✓ Skip list descends to the score boundary in $O(\log n)$, then walks the base layer for $k$ results. Cost scales with the result set, not the total member count." complexitytype="good" >}}
-- Return the top 100 players with scores between 4000 and 5000
ZRANGEBYSCORE leaderboard 4000 5000 LIMIT 0 100
{{< /codeblock >}}

{{< codeblock label="Avoid on large sets: $O(n)$" labeltype="bad" lang="bash" complexity="⚠ Without a score or rank bound, Redis must walk the entire base layer. On a set with millions of members, this will block the event loop." complexitytype="bad" >}}
-- Returns every member in the set, sorted by score
-- Catastrophic on large sorted sets
ZRANGE leaderboard 0 -1 WITHSCORES
{{< /codeblock >}}

**The listpack threshold matters for memory.** Below 128 members (configurable via `zset-max-listpack-entries`), Redis uses compact listpack encoding instead of the skip list. If your sorted sets stay small, you never pay the skip list overhead. A sorted set per user with a few dozen entries is far more memory-efficient than one global set with millions of entries, if your access pattern allows it.

---

{{< conclusion title="The Elegant Bet That Paid Off" label="Conclusion" >}}
A data structure that decides its own shape with a random number generator feels like something that breaks at 3 AM under production load.

It doesn't. The randomness replaces the most fragile part of balanced trees: the rebalancing logic. By accepting probabilistic balance instead of deterministic balance, the skip list eliminates an entire category of implementation bugs and concurrency hazards while delivering the same asymptotic complexity for every operation that matters.

Pugh's 1990 insight was simple: perfect balance is not the goal. Good-enough balance is, and you can get there with a coin flip, as long as you flip it for every node and let the law of large numbers handle the rest.

Redis, LevelDB, Java's standard library: they all reached for the skip list when they needed a sorted structure that was simple to write, simple to reason about, and simple to make concurrent.

**The next time you call `ZADD` or `ZRANK`, a coin is being flipped somewhere in the call stack. In thirty-six years of production use, it has never come up tails often enough to matter.**
{{< /conclusion >}}