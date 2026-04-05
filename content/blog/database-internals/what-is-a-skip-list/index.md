---
title: "The Probabilistic Gamble:<br>Why Redis Bets Your Data on a Coin Flip"
subtitle: "Every sorted set in Redis is backed by a data structure that decides its own shape by flipping coins. It should not work this well. Here is why it does."
date: 2026-04-05
author: "Imloul Anas"
tags: ["skip-list", "probabilistic", "redis", "sorted-sets"]
draft: false
---

There is a moment, when you first read the Redis source code, that stops you cold.

You are tracing how a `ZADD` command works. You follow the call stack down through the sorted set implementation, expecting to find something familiar: a balanced tree, a heap, perhaps a B-tree variant. Instead, you find a function called `zslInsert`, and inside it, a loop that calls `random()` to decide how tall to make the new node.
Go ahead i
A production database. Handling millions of operations per second. Making structural decisions with a random number generator.

Your first instinct is that this must be a quirk, a shortcut taken somewhere unimportant. But the more you read, the more you realize it is not a shortcut at all. It is a deliberate, mathematically principled design choice that trades the rigid guarantees of a balanced tree for something more valuable in practice: simplicity, cache efficiency, and lock-free concurrency that scales almost linearly with core count.

That structure is the **skip list**. And once you understand why it works, you will never look at a sorted index the same way again.

---

{{< section-label >}}The Problem{{< /section-label >}}

## What a Sorted Index Actually Needs to Do

Before examining the skip list, it is worth being precise about the problem it solves. Redis sorted sets (`ZSET`) are not a simple key-value store. They are a fully ordered index that must support all of the following operations efficiently:

- Insert a member with a score: `ZADD leaderboard 4200 "alice"`
- Delete a member by name: `ZREM leaderboard "alice"`
- Look up a member's rank: `ZRANK leaderboard "alice"`
- Retrieve members in a score range: `ZRANGEBYSCORE leaderboard 1000 5000`
- Retrieve members by rank range: `ZRANGE leaderboard 0 99`

This combination is the hard part. Any sorted array supports fast range scans but requires O(n) time to insert. A hash map supports O(1) lookup but has no ordering at all. A binary heap supports O(log n) insert but cannot do range queries without a full scan.

{{< callout title="Why this combination is genuinely difficult" >}}
The requirement to support both O(log n) point operations and O(log n + k) range scans, where k is the number of results returned, rules out most simple data structures immediately. The only classical answer is a balanced binary search tree: a red-black tree, an AVL tree, or a B-tree. These work. But they carry costs that matter enormously in Redis's operational context, and those costs are exactly what the skip list was designed to avoid.
{{< /callout >}}

---

{{< section-label >}}The Classical Answer{{< /section-label >}}

## What Balanced Trees Get Right, and What They Get Wrong

A red-black tree gives you everything the sorted set needs. Insertion, deletion, and search are all O(log n). In-order traversal gives you range scans in O(log n + k). It is the textbook answer, and it is the answer used by many databases and language standard libraries.

So why does Redis not use one?

The answer has nothing to do with algorithmic complexity, where the red-black tree and the skip list are essentially equivalent. It has everything to do with implementation complexity, memory layout, and what happens when multiple threads try to write to the structure simultaneously.

{{< definition icon="RBT" term="Red-Black Tree" >}}
A self-balancing binary search tree where every node is colored red or black according to a set of invariants that guarantee the tree never becomes more than twice as tall as it needs to be. Insertion and deletion trigger a sequence of color changes and rotations to restore those invariants. The logic is correct but notoriously difficult to implement, debug, and reason about under concurrency.
{{< /definition >}}

Consider what happens during a concurrent insert into a red-black tree. The rotation and recoloring operations that maintain balance can touch nodes far from the insertion point. In the worst case, a single insert requires a cascade of changes propagating all the way to the root. This means that to insert safely under concurrency, you must either lock the entire tree for the duration of the operation, or implement a highly sophisticated lock-coupling protocol that locks and unlocks nodes as the cascade propagates.

Both options are expensive. The first serializes all writes. The second is so complex that most implementations simply take the easy path and use a coarse-grained lock, which achieves the same serialization anyway.

{{< callout title="The concurrency problem is not theoretical" type="error" >}}
Redis is single-threaded for its command processing, which sidesteps this problem for the core data structures. But the lesson generalizes: systems like LevelDB, RocksDB, and many in-memory databases that do need concurrent writes have historically found balanced trees painful to make lock-free. The skip list, by contrast, has a natural concurrent variant that requires locking only a small, bounded set of nodes per operation, regardless of where the insert lands in the structure.
{{< /callout >}}

There is a second problem: memory access patterns. A red-black tree is a linked structure where each node contains a left pointer, a right pointer, a parent pointer, a color bit, and the key. On a 64-bit system, this is roughly 40 bytes of overhead per node before you have stored any actual data. More importantly, the nodes of a red-black tree are individually heap-allocated and scattered across memory. A traversal that visits 20 nodes is likely to incur 20 separate cache misses, because each pointer dereference lands on a different cache line.

The skip list does not fully solve this problem, but its structure has properties that make cache behavior more predictable in practice, as we will see.

---

{{< section-label >}}The Invention{{< /section-label >}}

## William Pugh's Insight: Approximate Balance Is Enough

The skip list was invented by William Pugh and described in his 1990 paper "Skip Lists: A Probabilistic Alternative to Balanced Trees." The central claim of that paper is captured in its subtitle: you do not need to guarantee balance. You only need to make imbalance astronomically unlikely.

The insight begins with a simple observation about sorted linked lists.

A sorted linked list supports O(n) search: you start at the head and walk forward until you find your key or pass it. This is too slow. But what if you added a second, sparser layer on top, a "fast lane" that skips over roughly half the nodes? You could scan the fast lane until you overshoot, then drop down to the base layer and scan the last few nodes. With two layers, you reduce the expected search time from n to roughly n/2.

Now add a third layer that skips over roughly half the second layer. And a fourth. And so on. If each layer skips over half the nodes of the layer below it, you have reconstructed something that behaves like binary search: each layer halves the search space, giving you O(log n) expected time.

{{< definition icon="SL" term="Skip List" >}}
A probabilistic data structure built as a hierarchy of sorted linked lists. The bottom layer (level 0) contains every element. Each higher layer contains a random subset of the elements from the layer below, where each element is independently promoted to the next level with probability p (typically 0.25 or 0.5). A search descends through the layers, using higher layers to skip large portions of the list and lower layers to refine the position.
{{< /definition >}}

The word "random" is doing critical work in that definition. In a deterministic balanced tree, the structure is forced into balance by explicit rebalancing operations after every insert or delete. In a skip list, the structure achieves approximate balance by having each node independently decide its own height by flipping a biased coin. No rebalancing is ever needed, because the randomness guarantees that, with high probability, the distribution of node heights across the structure approximates what a perfectly balanced tree would look like.

{{< callout title="What 'with high probability' actually means" type="info" >}}
For a skip list with n elements and promotion probability p = 0.5, the probability that the maximum height exceeds 3 log₂ n is at most 1/n. For a list with one million elements, that means the chance of the structure becoming pathologically tall is less than one in a million, per operation. In practice, this guarantee is strong enough that skip lists are used in production systems handling billions of operations without ever observing worst-case behavior.
{{< /callout >}}

---

{{< section-label >}}The Anatomy{{< /section-label >}}

## Inside a Skip List Node

A skip list node is structurally different from a tree node. Instead of a fixed set of left and right child pointers, each node contains a **tower** of forward pointers, one per level the node participates in. A node at level 3 has three forward pointers: one pointing to the next level-0 node, one pointing to the next level-1 node, and one pointing to the next level-2 node.

{{< codeblock label="Skip List internals" labeltype="neutral" lang="txt">}}
Level 3: head --------------------------------> [42] -----------------> NULL
Level 2: head ----------------> [17] ---------> [42] ---------> [61] -> NULL
Level 1: head -> [7] ---------> [17] -> [29] -> [42] ---------> [61] -> NULL
Level 0: head -> [7] -> [12] -> [17] -> [29] -> [42] -> [55] -> [61] -> NULL
{{< /codeblock >}}

A search for key 42 proceeds as follows. Start at the highest level of the head node. At level 3, the next node is 42, which matches exactly: done in 2 steps. If we were searching for 55, we would advance to 42 at level 3, find that the next node at level 3 is NULL, drop to level 2, find that the next node at level 2 is 61 which overshoots, drop to level 1, find 61 again, drop to level 0, and find 55. The higher levels act as an express lane, letting you skip large portions of the base list in a single pointer dereference.

{{< definition icon="FP" term="Forward Pointer Array" >}}
The array of next pointers stored in each skip list node, one entry per level. A node at height h stores h forward pointers. The total memory used by a node is proportional to its height, so nodes at higher levels consume more memory. With p = 0.25, the expected number of forward pointers per node is 1 + 0.25 + 0.0625 + ... = 1/(1-0.25) = 1.33, meaning the average node is only slightly larger than a singly-linked list node.
{{< /definition >}}

{{< diagram src="skiplist" caption="Skip List: the bottom layer contains every element. Each higher layer is a probabilistic subset of the layer below. Searches use higher layers to skip large portions of the list, dropping down as they approach the target." >}}

---

{{< section-label >}}The Operations{{< /section-label >}}

## Search, Insert, and Delete: How the Coin Flip Fits In

### Search

Search is the cleanest operation. Start at the highest level of the head sentinel node. At each level, advance forward as long as the next node's key is less than the target. When you can no longer advance without overshooting, drop one level and repeat. When you reach level 0 and can no longer advance, the next node is either your target or the target does not exist.

The expected number of pointer comparisons is O(log n), for the same reason that binary search is O(log n): each level approximately halves the search space.

{{< codeblock label="Search" labeltype="neutral" lang="txt" >}}
func search(list *SkipList, target int) *Node {
node := list.head
for level := list.maxLevel; level >= 0; level-- {
for node.next[level] != nil && node.next[level].key < target {
node = node.next[level] // advance along this level
}
// next node at this level would overshoot — drop down
}
node = node.next[0]
if node != nil && node.key == target {
return node
}
return nil // not found
}
{{< /codeblock >}}

### Insert

Insert begins with a search to find the correct position in the base list. During the search, the algorithm records the rightmost node visited at each level, storing them in an `update` array. These are the nodes whose forward pointers will need to change to accommodate the new node.

Then comes the coin flip. A random level is chosen for the new node by repeatedly generating a random number and checking whether it falls below the promotion probability p. Each successful flip promotes the node one level higher. The expected height of a new node is 1/(1-p): with p = 0.25, the expected height is 1.33 levels.

Once the height is determined, the new node is spliced in at every level from 0 up to its chosen height, using the `update` array to fix the forward pointers. No rotation. No recoloring. No cascade to the root. The insert touches exactly the nodes in the `update` array and nothing else.

{{< codeblock label="Insert" labeltype="neutral" lang="txt" >}}
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

{{< callout title="Why the update array is bounded" type="info" >}}
The update array has at most O(log n) entries, one per level. This means that regardless of where in the list the new node is inserted, the number of nodes that need to be modified is logarithmic and known in advance. This boundedness is what makes skip lists so amenable to fine-grained locking: you can lock exactly the nodes in the update array and nothing else, touching a minimal, predictable set of memory locations.
{{< /callout >}}

### Delete

Delete mirrors insert. A search finds the target node and populates the same `update` array. If the target exists, its forward pointers are bypassed at every level by updating the pointers in the `update` array to skip over it. The node is then freed.

Like insert, delete touches only the nodes in the `update` array. No structural rebalancing is needed, because the remaining nodes' random heights still produce a probabilistically balanced structure. Removing one node does not destabilize the distribution of heights across the rest of the list.

{{< codeblock label="Delete" labeltype="neutral" lang="txt" >}}
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

Redis does not use a skip list alone for its sorted sets. For small sorted sets (fewer than 128 members by default, or members whose values exceed 64 bytes), Redis uses a **listpack**, a compact encoding that stores all members sequentially in a single contiguous memory region. This is purely an optimization: a listpack with 10 members is faster to scan sequentially than a skip list with 10 members, and it uses far less memory.

Once a sorted set exceeds either threshold, Redis converts it to a structure that combines two data structures in parallel.

{{< definition icon="ZS" term="Redis zskiplist" >}}
The skip list used internally by Redis sorted sets, defined in `t_zset.c`. Each node stores the member string, its floating-point score, and a backward pointer (enabling reverse traversal) alongside the forward pointer array. The list is sorted primarily by score and secondarily by lexicographic order of the member string, which is how Redis breaks ties in `ZRANK` and `ZRANGE` operations.
{{< /definition >}}

{{< definition icon="ZD" term="Redis zset (the dual structure)" >}}
A sorted set in Redis above the listpack threshold is actually two structures sharing the same nodes: a skip list for ordered traversal and range queries, and a hash table mapping member strings to their scores for O(1) score lookup. Every `ZADD` writes to both. Every `ZREM` removes from both. The memory overhead is real, but it buys O(1) score lookup alongside O(log n) rank and range operations, which no single structure provides alone.
{{< /definition >}}

This dual-structure design reflects a recurring theme in Redis: use the right data structure for each access pattern, and pay the memory cost of maintaining both. The skip list answers "give me the top 100 members by score." The hash table answers "what is alice's score." Neither structure alone answers both questions efficiently.

{{< callout title="The promotion probability Redis chose" type="info" >}}
Redis uses p = 0.25 rather than the more intuitive p = 0.5. This reduces the average height of nodes, which reduces the total memory consumed by forward pointer arrays. The trade-off is a slightly higher expected number of comparisons per search (because higher levels are sparser), but the memory savings on a dataset of millions of members are substantial. The maximum level is capped at 64, which is enough to handle 2^64 elements before the probabilistic guarantees begin to degrade.
{{< /callout >}}

---

{{< section-label >}}The Complexity{{< /section-label >}}

## The Numbers, Side by Side

With the structure understood, the complexity picture becomes clear:

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
      <td><span class="tag good">O(log n)</span></td>
      <td><span class="tag good">O(log n)</span></td>
      <td><span class="tag good">O(log n) expected</span></td>
    </tr>
    <tr>
      <td>Insert</td>
      <td><span class="tag bad">O(n)</span></td>
      <td><span class="tag good">O(log n)</span></td>
      <td><span class="tag good">O(log n) expected</span></td>
    </tr>
    <tr>
      <td>Delete</td>
      <td><span class="tag bad">O(n)</span></td>
      <td><span class="tag good">O(log n)</span></td>
      <td><span class="tag good">O(log n) expected</span></td>
    </tr>
    <tr>
      <td>Range scan</td>
      <td><span class="tag good">O(log n + k)</span></td>
      <td><span class="tag good">O(log n + k)</span></td>
      <td><span class="tag good">O(log n + k) expected</span></td>
    </tr>
    <tr>
      <td>Rank lookup</td>
      <td><span class="tag good">O(log n)</span></td>
      <td><span class="tag neutral">O(log n) with augmentation</span></td>
      <td><span class="tag good">O(log n) with span augmentation</span></td>
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

The "expected" qualifier on skip list operations is the honest difference. A red-black tree guarantees O(log n) in the worst case. A skip list guarantees O(log n) only in expectation: the probability of exceeding it decays exponentially, but it is not zero. For the vast majority of production workloads, this distinction is irrelevant. For hard real-time systems where worst-case latency must be bounded with certainty, it matters.

---

{{< section-label >}}The Rank Trick{{< /section-label >}}

## How Redis Answers ZRANK in O(log n)

A naive skip list can tell you whether a key exists and what its neighbors are, but it cannot tell you a key's rank (its ordinal position in the sorted order) without scanning the entire base layer. Redis's implementation adds one piece of augmentation to solve this: a **span** value on every forward pointer.

{{< definition icon="SP" term="Span" >}}
An integer stored alongside each forward pointer in the skip list, recording how many base-layer nodes that pointer skips over. A forward pointer at level 2 that jumps from node A to node C, skipping over nodes B1 and B2, has a span of 3. By summing the spans of all forward pointers traversed during a search, Redis accumulates the exact rank of the target node without ever touching the base layer nodes in between.
{{< /definition >}}

This augmentation is maintained during inserts and deletes by adjusting the span values of the nodes in the `update` array. The cost is bounded: the `update` array has at most O(log n) entries, so span maintenance adds only a constant factor to insert and delete operations.

The result is that `ZRANK` runs in O(log n) time with no additional data structure, no auxiliary array, and no scan of the base layer. It is a clean example of a pattern that appears throughout database internals: augment a traversal structure with a small amount of per-node metadata to unlock a new class of queries at minimal cost.

{{< callout title="The connection to Order Statistics Trees" type="info" >}}
The span augmentation in Redis's skip list is conceptually identical to the subtree count augmentation in an Order Statistics Tree. Both record "how many elements are below or behind this pointer" to enable O(log n) rank queries. The critical difference is the update cost. In an OST on a B-tree, every insert must cascade count updates all the way to the root, touching O(log n) nodes that may be spread across multiple pages. In the skip list, span updates are confined to the update array nodes, which were already going to be modified by the insert anyway. There is no additional cascade.
{{< /callout >}}

---

{{< section-label >}}Concurrency{{< /section-label >}}

## Why Skip Lists Scale Under Concurrent Writes

The concurrency story is where the skip list most clearly outperforms balanced trees in practice.

Recall the update array from the insert operation: the set of rightmost nodes visited at each level during the search phase. These are the only nodes whose forward pointers need to change. In a concurrent insert, you can lock exactly these nodes, perform the splice, and release all locks. The rest of the structure is untouched.

This property is called **localized modification**. It means that two concurrent inserts into different parts of the list are very likely to touch disjoint sets of nodes in their update arrays, and can therefore proceed in parallel without contention.

Compare this to a red-black tree, where a rotation triggered by an insert at a leaf can propagate changes upward through an arbitrary number of ancestors. In the worst case, a rebalancing cascade touches O(log n) nodes between the insertion point and the root, and those nodes are shared by every traversal in the tree.

{{< pillars >}}
{{< pillar num="01" title="Localized Modification: inserts touch a bounded, predictable set of nodes" >}}
The update array contains at most O(log n) entries. Every node that needs to change is identified during the search phase, before any locks are acquired. This makes the locking protocol simple, correct, and efficient.
{{< /pillar >}}
{{< pillar num="02" title="No Rebalancing Cascade: randomness replaces rotations" >}}
Because the skip list never needs to rebalance, there is no operation that can trigger an unbounded cascade of structural changes. The worst case for any single insert or delete is bounded by the node's height, which is logarithmic with high probability.
{{< /pillar >}}
{{< pillar num="03" title="Lock-Free Variants: the structure enables non-blocking algorithms" >}}
The bounded modification footprint makes it possible to implement lock-free skip lists using compare-and-swap operations. Systems like Java's ConcurrentSkipListMap use exactly this approach, achieving near-linear throughput scaling with thread count — something balanced trees have never achieved cleanly.
{{< /pillar >}}
{{< /pillars >}}

---

{{< section-label >}}Memory Layout{{< /section-label >}}

## The Cache Behavior of a Skip List

One criticism leveled at skip lists is their memory overhead: variable-height nodes with individually allocated forward pointer arrays are harder to lay out efficiently in memory than the fixed-size nodes of a balanced tree.

This criticism is partly valid. An individual skip list node, with its score, member pointer, backward pointer, level count, and forward pointer array, is larger than a simple tree node. On a dataset of 10 million members, this overhead is measurable.

But the criticism misses an important access pattern advantage. During a search, the skip list's higher levels act as an increasingly coarse index over the data. The top few levels of a heavily-used skip list are accessed on virtually every operation and will remain hot in the CPU cache. The probability that a level-k node exists at a given position is p^k, so for p = 0.25, level 3 nodes appear in roughly 1.5% of positions. A dataset of 10 million elements has roughly 150,000 level-3 nodes: a small enough set to fit comfortably in L3 cache and stay there under sustained load.

{{< callout title="The upper levels behave like a cache-resident index" type="info" >}}
This mirrors the buffer pool behavior of B-trees described in the previous article. Just as the upper levels of a B-tree tend to remain in the database's page cache indefinitely because they are accessed on every query, the upper levels of a skip list tend to remain in CPU cache because they are visited on every search. The probabilistic structure accidentally recreates the locality properties of a deliberately designed hierarchical index.
{{< /callout >}}

---

{{< section-label >}}Where Skip Lists Are Used{{< /section-label >}}

## Beyond Redis: Where This Structure Appears

Redis is the most prominent user of skip lists, but the structure appears across a surprising range of systems.

**LevelDB and RocksDB** use a skip list as the in-memory write buffer (the MemTable). New writes land in the skip list first, where they can be retrieved by subsequent reads before the data is flushed to disk as an SSTable. The skip list is ideal here: it supports both point lookups and range scans, inserts are fast, and the entire structure can be iterated in sorted order when it is time to flush. Concurrent access to the MemTable in RocksDB uses a lock-free skip list variant.

**Apache Lucene** uses skip lists inside its inverted index posting lists to accelerate the merging of multiple posting lists during boolean query evaluation. When a query matches multiple terms, Lucene must intersect or union their posting lists. Skip pointers embedded in the lists allow the merge algorithm to jump forward large distances when one list is much sparser than another, reducing the work from O(n) to O(n/k) in favorable cases.

**Java's ConcurrentSkipListMap** is the standard library's concurrent sorted map, used whenever application code needs a thread-safe sorted structure without the serialization cost of `Collections.synchronizedSortedMap`. It uses a lock-free skip list implementation based on compare-and-swap operations.

{{< callout title="A pattern worth noticing" type="info" >}}
In every case above, the skip list is chosen not because it has better asymptotic complexity than a balanced tree, since it does not, but because it is simpler to implement correctly under concurrency. The randomness that makes the structure feel unprincipled at first is precisely what eliminates the complex rebalancing logic that makes concurrent balanced trees hard to get right.
{{< /callout >}}

---

{{< section-label >}}The Honest Trade-offs{{< /section-label >}}

## What the Skip List Gives Up

No data structure is without costs. The skip list's advantages come with three genuine trade-offs that are worth understanding before reaching for it.

**Worst-case complexity is probabilistic, not guaranteed.** A red-black tree guarantees O(log n) for every single operation. A skip list guarantees O(log n) in expectation, with exponentially decaying probability of exceeding it. For most workloads, this distinction is academic. For systems that require hard latency bounds, such as real-time control systems or financial matching engines with strict SLA requirements, a balanced tree's deterministic guarantee may be preferable.

**Memory overhead is higher than a balanced tree.** Each forward pointer in the skip list consumes 8 bytes on a 64-bit system. A node at height 4 has 4 forward pointers plus a backward pointer plus the score plus the member pointer: roughly 56 bytes of overhead before any data. A red-black tree node has a left pointer, right pointer, parent pointer, and color bit: roughly 32 bytes. With p = 0.25, the expected total forward pointer overhead per node is about 10.7 bytes, which is competitive, but the maximum-height outlier nodes are substantially larger.

**No persistent, on-disk variant exists.** The skip list is fundamentally an in-memory structure. Its variable-length nodes, pointer-heavy layout, and lack of page alignment make it ill-suited for disk-based storage. When data must be persisted to disk in sorted order, the B-tree's page-aligned, fixed-size node structure is the correct tool. This is why Redis uses skip lists for in-memory sorted sets and why LevelDB uses B-trees (specifically, LSM-tree SSTables) for its on-disk component, while using a skip list only for its in-memory buffer.

---

{{< section-label >}}Putting It Together{{< /section-label >}}

## What This Means for the Redis Commands You Run Every Day

The skip list's structure has direct, observable consequences for the commands Redis exposes and how you should use them.

**`ZADD` and `ZREM` are O(log n).** Each operation descends the skip list to find the insertion or deletion point, populates the update array, performs the splice, and updates span values. The cost is proportional to the height of the structure, which is O(log n) with high probability. At a million members, this is roughly 20 pointer comparisons.

**`ZRANGE` and `ZRANGEBYSCORE` are O(log n + k).** The skip list descends to the starting position in O(log n), then walks the base layer forward, returning k results. The base layer walk is purely sequential pointer chasing, which is cache-friendly and fast.

**`ZRANK` is O(log n) because of span augmentation.** Without spans, this would require an O(n) scan of the base layer. The span values accumulated during the search give the exact rank as a byproduct of the descent.

{{< codeblock label="Efficient — O(log n + k) range scan" labeltype="good" lang="redis" complexity="✓ Skip list descends to the score boundary in O(log n), then walks the base layer for k results. Cost scales with the result set, not the total member count." complexitytype="good" >}}
-- Return the top 100 players with scores between 4000 and 5000
ZRANGEBYSCORE leaderboard 4000 5000 LIMIT 0 100
{{< /codeblock >}}

{{< codeblock label="Avoid on large sets — O(n)" labeltype="bad" lang="redis" complexity="⚠ Without a score or rank bound, Redis must walk the entire base layer. On a set with millions of members, this will block the event loop." complexitytype="bad" >}}
-- Returns every member in the set, sorted by score
-- Catastrophic on large sorted sets
ZRANGE leaderboard 0 -1 WITHSCORES
{{< /codeblock >}}

**The listpack threshold matters for memory.** Below 128 members (configurable via `zset-max-listpack-entries`), Redis uses a compact listpack encoding rather than the skip list. If your sorted sets are small and stay small, you are never paying the skip list's memory overhead. Design your data model around this: a sorted set per user with a few dozen entries is far more memory-efficient than a single global sorted set with millions of entries, if your access pattern permits it.

---

{{< conclusion title="The Elegant Bet That Paid Off" label="Conclusion" >}}
The skip list should not inspire confidence the first time you encounter it. A data structure that decides its own shape with a random number generator feels like an engineering shortcut, the kind of thing that works in demos and fails at 3 AM under production load.

The reality is the opposite. The randomness is not a shortcut. It is a principled replacement for the most fragile part of balanced tree implementations: the rebalancing logic. By accepting a probabilistic rather than a deterministic balance guarantee, the skip list eliminates the entire category of bugs and concurrency hazards that make balanced trees hard to implement correctly. It does so while delivering identical asymptotic complexity for every operation that matters.

William Pugh's insight in 1990 was that perfect balance is not the goal. Predictable, reliable, good-enough balance is the goal, and you can achieve it with a coin flip, as long as you flip it for every node and let the law of large numbers do the rest.

Redis understood this. LevelDB understood this. Java's standard library understood this. The skip list appears wherever engineers need a sorted structure that is simple to implement, simple to reason about, and simple to make concurrent, because in production systems, simple correct code outlasts clever correct code almost every time.

**The next time you call `ZADD` or `ZRANK`, a coin is being flipped somewhere in the call stack. It has never, in thirty-five years of production use, come up tails often enough to matter.**
{{< /conclusion >}}
