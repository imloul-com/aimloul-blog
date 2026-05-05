---
title: "The Probabilistic Gamble:<br>Why Redis Bets Your Data on a Coin Flip"
subtitle: "Redis stores every sorted set in a data structure that flips coins to decide its own shape. And it turns out that's the smart move."
date: 2026-04-05
author: "Imloul Anas"
tags: ["skip-list", "probabilistic", "redis", "sorted-sets"]
draft: false
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

You need both: fast single-item operations ($O(\log n)$) *and* fast range scans ($O(\log n + k)$, where $k$ is the number of results returned). That combination is what narrows the field. The textbook answer is a balanced binary search tree: a red-black tree, an AVL tree, or a B-tree. These work, but they carry costs that matter in Redis's context, and those costs are what the skip list was designed to avoid.

---

{{< section-label >}}The Classical Answer{{< /section-label >}}

## What Balanced Trees Get Right, and What They Get Wrong

A red-black tree gives you everything the sorted set needs. Insertion, deletion, and search are all $O(\log n)$. An in-order traversal (visiting nodes in sorted order by walking left subtree, then node, then right subtree) gives you range scans in $O(\log n + k)$. It's what most standard libraries reach for when they need a sorted map.

So why doesn't Redis use one?

The algorithmic complexity is essentially the same. The real differences are implementation complexity, memory layout, and how well the structure holds up under concurrent writes. Redis itself is single-threaded for command processing, so the concurrency angle doesn't bite it directly. But Redis borrowed the skip list from a lineage of systems that *do* run concurrent writers (LevelDB, RocksDB, Java's standard library), and understanding why those systems picked it is the clearest way to see what the skip list actually buys you. So the critique that follows is aimed at balanced trees in general, not at Redis's specific use case.

{{< definition icon="RBT" term="Red-Black Tree" >}}
A self-balancing binary search tree that guarantees $O(\log n)$ operations by enforcing structural rules after every insert and delete. Correct, but hard to implement and harder to make concurrent. [Wikipedia](https://en.wikipedia.org/wiki/Red%E2%80%93black_tree)
{{< /definition >}}

{{< diagram src="redblacktree" caption="Red–black tree at a glance: a binary search tree whose nodes are colored red or black so the tree stays approximately balanced (same black-node count on every path from the root, no two consecutive reds, and similar rules). Dark nodes are black, bright nodes are red. For the full invariant list and history, see the Wikipedia article linked in the definition above." >}}

When you insert into a red-black tree, the tree fixes itself with *rotations* (local swaps that change which node sits above which) and *recoloring* (flipping nodes between red and black to restore the balance rules). These fixups can touch nodes far from the insertion point, sometimes cascading all the way to the root. To insert safely when multiple threads are writing at once, you either take a single coarse-grained lock (one lock covering the whole tree, which forces writes to happen one at a time) or implement a protocol where threads hand off locks as they descend the tree, called lock coupling. Most implementations take the easy path and use the coarse lock.

{{< callout title="Where the concurrency cost actually lands" type="info" >}}
Because Redis processes commands one at a time on a single thread, no two commands ever touch a sorted set simultaneously. The concurrency argument against balanced trees doesn't apply to Redis directly. But systems like LevelDB, RocksDB, and many in-memory databases need real concurrent writes, and they've all found balanced trees painful to make lock-free (meaning threads coordinate without blocking each other). The skip list has a natural concurrent variant that only locks a small, bounded set of nodes per operation. That property is what made it the default choice across this whole family of systems, and it's why the idea migrated to Redis.
{{< /callout >}}

There is a second problem, and this one *does* apply to Redis: memory access patterns. A red-black tree node holds left, right, and parent pointers, a color bit, and the key, roughly 32 bytes of overhead on a 64-bit system. Worse, each node is allocated separately and ends up scattered across memory. Scattered nodes are slow to visit, for reasons worth pinning down precisely.

{{< definition icon="CL" term="Cache Line" >}}
The CPU doesn't fetch memory one byte at a time. It grabs a 64-byte chunk called a cache line and keeps recently-used chunks in a small, fast on-chip memory called the CPU cache. Accessing data already in cache is roughly 100x faster than fetching it from main memory. When two pieces of data you need sit on different cache lines, you pay the full fetch cost for each one.
{{< /definition >}}

In a red-black tree, each pointer jump probably lands on a different cache line, forcing the CPU to wait for a fresh memory fetch. A traversal that visits 20 nodes likely incurs 20 of those waits. The skip list doesn't fully solve this (its nodes are also heap-allocated), but its structure makes cache behavior more predictable, for reasons we'll get to.

---

{{< section-label >}}The Invention{{< /section-label >}}

## William Pugh's Insight: Approximate Balance Is Enough

The skip list comes from a 1990 paper by William Pugh, ["Skip Lists: A Probabilistic Alternative to Balanced Trees."](https://15721.courses.cs.cmu.edu/spring2018/papers/08-oltpindexes1/pugh-skiplists-cacm1990.pdf) The core idea: you don't need to guarantee balance. You just need to make imbalance vanishingly unlikely.

Start with a sorted linked list. Search is $O(n)$, you walk forward until you find your key. Too slow. But add a second, sparser layer on top, a "fast lane" that skips over roughly half the nodes. Scan the fast lane until you overshoot, drop down, scan the last few nodes. Two layers cut search time roughly in half.

Now add a third layer that skips half the second. And a fourth. If each layer contains roughly half the nodes of the layer below, you get something that behaves like binary search: each level roughly halves the search space, giving $O(\log n)$ expected time.

More generally, if each node is promoted to the next layer with probability $p$, each level cuts the search space by a factor of $1/p$. With $p = 0.5$ that's a halving per level. With $p = 0.25$ each level cuts the space by 4, which means fewer levels overall but slightly more comparisons per level.

{{< definition icon="SL" term="Skip List" >}}
A probabilistic data structure built as a hierarchy of sorted linked lists. The bottom layer (level 0) contains every element. Each higher layer contains a random subset of the layer below, where each element is independently promoted with probability p (typically 0.25 or 0.5). Searches descend through the layers, using higher layers to skip large portions and lower layers to refine the position.
{{< /definition >}}

The word "random" is doing critical work here. A balanced tree forces balance through explicit rotations after every insert or delete. A skip list achieves approximate balance by having each node decide its own height with a biased coin flip (a random draw where the probability of "heads" is p, not necessarily 50/50). No rebalancing is ever needed. The randomness is enough, almost all of the time, to keep the heights distributed the way a balanced tree would.

{{< callout title="What 'with high probability' actually means" type="info" >}}
For a skip list with $n$ elements, the chance of ending up badly unbalanced shrinks so fast as $n$ grows that it stops mattering in practice. With one million elements, the odds of hitting pathological height on any given operation are less than one in a million. Skip lists handle billions of operations in production without ever tripping a worst case.
{{< /callout >}}

---

{{< section-label >}}The Anatomy{{< /section-label >}}

## Inside a Skip List Node

Instead of left and right child pointers, each skip list node contains a **tower** of forward pointers, one per level it participates in. A node at level 3 has three forward pointers: one for each level, each pointing to the next node at that level.

{{< diagram src="skiplist" caption="Skip List: the bottom layer contains every element. Each higher layer is a probabilistic subset of the layer below. Searches use higher layers to skip large portions of the list, dropping down as they approach the target." >}}

Searching for 42: start at the top level of the head node. At level 3, the next node is 42, done. Searching for 55: advance to 42 at level 3, next is NULL, drop to level 2, next is 61 (overshoots), drop to level 1, 61 again, drop to level 0, find 55. The higher levels act as an express lane, skipping large chunks of the list in a single pointer jump.

{{< definition icon="FP" term="Forward Pointer Array" >}}
Each skip list node stores an array of next-pointers, one per level. A node at height h has h forward pointers. The expected height is $1/(1-p)$, so with $p = 0.25$ the average node carries about 1.33 forward pointers, only slightly larger than a regular linked list node.
{{< /definition >}}

---

{{< section-label >}}The Operations{{< /section-label >}}

## Search, Insert, and Delete: How the Coin Flip Fits In

Now that you know what a node looks like, here's how the three core operations use that tower structure. All three share the same descent pattern, and keeping it in mind will make the code below easy to read: start at the top level, walk forward until you overshoot, drop down a level, repeat. The only thing that changes between operations is what you do once you get there.

### Search

Start at the top level of the head node. At each level, advance forward while the next node's key is less than the target. When advancing would overshoot, drop one level. At level 0, the next node is either your target or it doesn't exist. Expected comparisons: $O(\log n)$, each level cuts the search space by a factor of $1/p$.

Notice the outer loop descending levels and the inner loop walking forward. That's the two-dimensional search pattern the whole structure is built around.

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

Then the coin flip. The new node's height is chosen by repeatedly flipping a biased coin (probability p): each heads promotes it one level higher, each tails stops. Expected height works out to $1/(1-p)$, about 1.33 levels on average with the probability Redis uses. Most nodes stay short. A few grow tall enough to serve as express-lane stops on the upper levels.

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

{{< section-label >}}The Complexity{{< /section-label >}}

## The Numbers, Side by Side

With the structure understood, here's how it compares. Two columns mention **augmentation**, meaning extra metadata stored on each node (like a subtree-size counter on a tree, or the span values Redis attaches to skip list pointers, covered later in this article) to unlock queries the plain structure can't answer efficiently.

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

The "expected" qualifier is the honest difference. A red-black tree guarantees $O(\log n)$ worst case. A skip list guarantees it in expectation: the probability of exceeding it shrinks exponentially as $n$ grows, but it's not zero. For most production workloads, this is irrelevant. For hard real-time systems with strict latency bounds, it matters.

---

{{< section-label >}}Concurrency{{< /section-label >}}

## Why Skip Lists Scale Under Concurrent Writes

When multiple threads try to modify a data structure at once, you need rules to stop them from corrupting each other's work. Those rules (locks, atomic operations, ordering guarantees) are the hard part of building concurrent systems, and skip lists make them easier than trees do. This is where skip lists most clearly win in practice.

Remember the update array: the only nodes whose pointers change during an insert. In a concurrent setting, you lock exactly those nodes, splice in the new node, and release. Two inserts into different parts of the list touch disjoint update arrays and proceed in parallel without contention.

This is **localized modification**. The structural change lives in a small, known set of nodes instead of rippling outward. Compare it to a red-black tree, where a rotation at a leaf can cascade upward through ancestors that are shared by every traversal in the tree.

{{< pillars >}}
{{< pillar num="01" title="Localized Modification" >}}
The update array has at most $O(\log n)$ entries, all identified during the search phase before any locks are acquired. Simple, predictable locking.
{{< /pillar >}}
{{< pillar num="02" title="No Rebalancing Cascade" >}}
No operation triggers unbounded structural changes. The worst case for any insert or delete is bounded by the node's height, which is logarithmic with high probability.
{{< /pillar >}}
{{< pillar num="03" title="Lock-Free Variants" >}}
The bounded modification footprint enables lock-free implementations using compare-and-swap, a CPU instruction that atomically updates a pointer only if it still holds an expected value (letting threads coordinate without explicit locks). Java's `ConcurrentSkipListMap` uses this approach, so throughput keeps climbing as you add threads instead of plateauing.
{{< /pillar >}}
{{< /pillars >}}

---

{{< section-label >}}Memory Layout{{< /section-label >}}

## The Cache Behavior of a Skip List

A fair criticism of skip lists: variable-height nodes with individually allocated pointer arrays are harder to lay out in memory than fixed-size tree nodes. On 10 million members, the overhead is measurable.

But this misses an access pattern advantage. Recall from earlier that anything already in CPU cache is roughly 100x faster to read than main memory. CPUs actually have several cache levels (L1, L2, and L3, in increasing size and decreasing speed), and L3 is typically tens of megabytes on modern server CPUs. So anything small enough to fit in L3 and touched often enough to stay there is effectively free to access.

The higher levels of a skip list fit that profile exactly. The top few levels are touched on virtually every operation, so they stay hot in cache. With p = 0.25, level-3 nodes appear at roughly 1.5% of positions. A 10-million-element dataset has about 150,000 level-3 nodes, a few megabytes at most, small enough to sit comfortably in L3 cache under sustained load.

{{< callout title="The upper levels behave like a cache-resident index" type="info" >}}
Just as the upper levels of a B-tree tend to stay in the database's page cache because they're accessed on every query, the upper levels of a skip list tend to stay in CPU cache because they're visited on every search. The probabilistic structure incidentally recreates the locality properties of a deliberately designed hierarchical index.
{{< /callout >}}

---

{{< section-label >}}The Redis Implementation{{< /section-label >}}

## How Redis Actually Uses It

Redis doesn't use a skip list for every sorted set. Small ones use a **listpack**, a compact encoding that stores everything sequentially in contiguous memory. Faster to scan, less memory. Once a sorted set crosses a threshold (more than 128 members, or any member longer than 64 bytes, by default), Redis automatically converts it in place to the skip list structure, transparently, on the write that crosses the limit.

One detail worth flagging before the definitions below: Redis sorted sets allow two members to have the same score (two players tied at 4200 points, for example). When that happens, Redis breaks the tie by the lexicographic order (dictionary order) of the member string, so the ordering is always deterministic.

{{< definition icon="ZS" term="Redis zskiplist" >}}
Redis's skip list implementation, defined in `t_zset.c`. Each node stores the member string, its floating-point score, and a backward pointer for reverse traversal, alongside the forward pointer array. Sorted primarily by score, secondarily by dictionary order of the member string, so two members with identical scores still have a stable, deterministic ordering.
{{< /definition >}}

{{< definition icon="ZD" term="Redis zset (the dual structure)" >}}
Above the listpack threshold, a sorted set is two structures in parallel: a skip list for ordered traversal and range queries, and a hash table mapping member strings to scores for $O(1)$ lookup. Every `ZADD` writes to both. Every `ZREM` removes from both.
{{< /definition >}}

The skip list answers "give me the top 100 by score." The hash table answers "what is alice's score?" Neither alone handles both efficiently, so Redis maintains both and pays the memory cost.

{{< callout title="Why Redis uses p = 0.25" type="info" >}}
Most textbook examples use p = 0.5, but Redis chose 0.25. Sparser upper levels mean each node carries fewer forward pointers on average (about 1.33 vs 2), saving memory at the cost of slightly more comparisons per search. For millions of members, the memory savings win. The maximum level is capped at 64, enough for $2^{64}$ elements.
{{< /callout >}}

---

{{< section-label >}}The Rank Trick{{< /section-label >}}

## How Redis Answers ZRANK in $O(\log n)$

A plain skip list can tell you whether a key exists, but not its rank (ordinal position) without scanning the entire base layer. Redis solves this by adding a **span** value to every forward pointer.

{{< definition icon="SP" term="Span" >}}
An integer on each forward pointer recording how many base-layer nodes it skips over. A level-2 pointer jumping from A to C, skipping B1 and B2, has a span of 3. By summing spans along the search path, Redis gets the exact rank without touching the nodes in between.
{{< /definition >}}

Spans are maintained during inserts and deletes by adjusting values in the `update` array, adding only a constant factor to those operations.

The result: `ZRANK` runs in $O(\log n)$ with no extra data structure and no base-layer scan. It's a clean example of augmenting a traversal structure (attaching small pieces of derived metadata to each node) to unlock a new query type at minimal cost.

---

{{< section-label >}}Where Skip Lists Are Used{{< /section-label >}}

## Beyond Redis: Where This Structure Appears

Redis is the most visible user, but skip lists show up in more places than you'd expect.

**LevelDB and RocksDB** (embedded storage engines used inside databases like Cassandra, CockroachDB, and many others) use a skip list as their in-memory write buffer. Writes land in the skip list first, queryable immediately, then get flushed to disk in batches. The skip list supports point lookups, range scans, fast inserts, and sorted iteration for flushing, everything the write buffer needs in one structure. RocksDB uses a lock-free variant for concurrent access.

**Apache Lucene** (the full-text search library behind Elasticsearch and Solr) uses skip lists to speed up boolean query evaluation. When intersecting or unioning result lists from different search terms, skip pointers let the merge algorithm jump forward over irrelevant entries instead of walking every position.

**Java's ConcurrentSkipListMap** is the standard library's concurrent sorted map, a lock-free implementation that avoids the bottleneck of wrapping a regular map in a synchronized block.

{{< callout title="A pattern worth noticing" type="info" >}}
In every case, the skip list is chosen not for better big-O behavior (it's the same) but because it is simpler to implement correctly under concurrency. The randomness that feels unprincipled is exactly what eliminates the rebalancing logic that makes concurrent balanced trees so hard to get right.
{{< /callout >}}

---

{{< section-label >}}The Honest Trade-offs{{< /section-label >}}

## What the Skip List Gives Up

Three genuine tradeoffs worth knowing.

**Worst-case complexity is probabilistic, not guaranteed.** A red-black tree guarantees $O(\log n)$ for every operation. A skip list guarantees it in expectation. For most workloads, this is academic. For hard real-time systems or financial matching engines with strict latency requirements, the deterministic guarantee may matter.

**Memory overhead is higher, but not by as much as it first looks.** The per-node comparison depends on what you count. A height-4 Redis node is around 56 bytes total (4 forward pointers, a backward pointer, a score, a member pointer) against roughly 32 bytes for a red-black tree node. But height 4 is not the average: with $p = 0.25$, the average node is only about 1.33 levels tall, so the *average* skip list node carries roughly 10.7 bytes of forward-pointer overhead on top of the key/value payload, competitive with a red-black tree once you account for the tree's color bit and three pointers. Put plainly: most nodes are small, a few tall outliers are genuinely larger, and the total memory footprint is modestly higher than a tree but not dramatically so. On a sorted set with 10 million members, that works out to a handful of extra megabytes, not gigabytes.

**No on-disk variant.** The skip list is an in-memory structure. Variable-length nodes and pointer-heavy layout make it unsuitable for disk storage. This is why LevelDB and RocksDB use skip lists for the in-memory write buffer but B-trees for the on-disk files.

---

{{< section-label >}}Putting It Together{{< /section-label >}}

## What This Means for the Redis Commands You Use

With the structure in hand, here's what actually happens when you run the commands you already know.

**`ZADD` and `ZREM` are $O(\log n)$.** Descend the skip list, populate the update array, splice, update spans. At a million members, roughly 20 pointer comparisons.

**`ZRANGE` and `ZRANGEBYSCORE` are $O(\log n + k)$.** Descend to the start position in $O(\log n)$, then walk the base layer forward for $k$ results. The base-layer walk follows `next` pointers one at a time, which is cache-friendly here because consecutive nodes tend to be accessed together and often share the same cache line.

**`ZRANK` is $O(\log n)$ thanks to span augmentation.** Without spans, this would be an $O(n)$ base-layer scan. The span values accumulated during descent give the exact rank as a byproduct.

{{< codeblock label="Efficient: $O(\log n + k)$ range scan" labeltype="good" lang="bash" complexity="✓ Skip list descends to the score boundary in $O(\log n)$, then walks the base layer for $k$ results. Cost scales with the result set, not the total member count." complexitytype="good" >}}
-- Return the top 100 players with scores between 4000 and 5000
ZRANGEBYSCORE leaderboard 4000 5000 LIMIT 0 100
{{< /codeblock >}}

{{< codeblock label="Avoid on large sets: $O(n)$" labeltype="bad" lang="bash" complexity="⚠ Without a score or rank bound, Redis must walk the entire base layer. Because Redis processes commands on a single thread, a long-running command like this blocks every other client until it finishes. On a set with millions of members, that can mean seconds of stalled traffic." complexitytype="bad" >}}
-- Returns every member in the set, sorted by score
-- Catastrophic on large sorted sets
ZRANGE leaderboard 0 -1 WITHSCORES
{{< /codeblock >}}

**The listpack threshold matters for memory.** Below 128 members (configurable via `zset-max-listpack-entries`), Redis uses compact listpack encoding instead of the skip list. If your sorted sets stay small, you never pay the skip list overhead. A sorted set per user with a few dozen entries is far more memory-efficient than one global set with millions of entries, if your access pattern allows it.

---

{{< conclusion title="The Elegant Bet That Paid Off" label="Conclusion" >}}
What looks like an unprincipled shortcut, deciding structure with a coin flip, turns out to be the point. The randomness replaces the most fragile part of balanced trees: the rebalancing logic. Accept probabilistic balance instead of deterministic balance and an entire category of implementation bugs and concurrency hazards disappears, at no cost to the big-O numbers anyone actually cares about.

That's why the same structure keeps showing up whenever someone needs a sorted index that's simple to write, simple to reason about, and simple to make concurrent: Redis, LevelDB, RocksDB, Java's standard library.

**The next time you call `ZADD` or `ZRANK`, a coin is being flipped somewhere in the call stack. In the decades since Pugh's paper, it has never come up tails often enough to matter.**
{{< /conclusion >}}