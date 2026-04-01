---
title: "The Universal Blueprint:<br>Why Everything in Your Database is a B-Tree"
subtitle: "From the physics of spinning platters to the geometry of NVMe flash, one data structure has dominated database storage for five decades. This is not a coincidence."
date: 2026-03-29
author: "Imloul Anas"
tags: ["b-tree", "indexing", "storage", "disk-io"]
next: "the-forbidden-data-structure"
draft: false
math: true
---

It is a question every developer eventually asks, usually late at night, staring at a query plan they don't fully understand.

You've just added an index to a table with 200 million rows. The query that took 8 seconds now returns in 3 milliseconds. You know *that* it works. But you've never been forced to reckon with *why*.

The honest answer goes deeper than most tutorials will take you. It begins not with code, but with physics: with the brutal, unavoidable gap between how fast your CPU thinks and how slowly your disk responds. And it ends with a single data structure, invented in 1970, that has proven so perfectly matched to the laws of hardware that no competitor has displaced it in over fifty years.

That structure is the **B-tree**. Understanding it (really understanding it) changes how you read query plans, how you choose indexes, and how you reason about why some queries are fast and others are slow regardless of how much hardware you throw at them.

---

{{< section-label >}}The Fundamental Problem{{< /section-label >}}

## The Latency Chasm Your Database Was Built to Cross

Before examining any data structure, you need to internalize one uncomfortable truth about the hardware your database runs on. Modern computing exists in a state of permanent, violent tension between two tiers of memory that operate at incompatible speeds.

Your CPU can reference its L1 cache in roughly **0.5 nanoseconds**. Main RAM takes about **100 nanoseconds**, already 200× slower, but still fast enough to feel instantaneous. Then the floor drops out entirely.

A random read from an SSD takes approximately **100,000 to 150,000 nanoseconds**, a 1,000× penalty compared to RAM. And a traditional spinning hard disk, where a mechanical arm must physically seek to the right track and wait for the platter to rotate into position, can cost **10,000,000 nanoseconds**, a full 10 milliseconds per access.

{{< callout title="Why these numbers define everything" >}}
A single hard disk seek takes as long as 100,000 RAM accesses. If your database had to perform even a dozen random disk reads per query, users would watch a spinner. Every architectural decision in a storage engine, every trade-off, every design choice, is ultimately an attempt to minimize how many of those catastrophically expensive disk reads a query requires.
{{< /callout >}}

There is a second, equally important constraint: storage hardware doesn't let you read one byte. It forces you to read an entire **block**, typically 4 KB or 8 KB at a time. This is true of both HDDs and SSDs. They differ in *why* (mechanical geometry vs. flash cell organization), but not in *what*. PostgreSQL and Oracle use 8 KB pages. InnoDB defaults to 16 KB pages (this is configurable; some workloads tune it up to 64 KB).

This constraint, at first glance a limitation, is actually the key insight that makes the B-tree work.

{{< callout title="The single most important principle in storage engine design" >}}
Reading 8 bytes costs exactly the same as reading 8,192 bytes, because the hardware will fetch the entire page regardless. Therefore, the goal is not to minimize *bytes* read. It is to minimize *page reads*. Every data structure in database storage is evaluated on one criterion: how few pages does it touch to answer a query?
{{< /callout >}}

---

{{< section-label >}}The Graveyard{{< /section-label >}}

## The Data Structures That Couldn't Cross It

Before understanding why the B-tree won, it helps to understand what lost, and precisely *why* each alternative fails. Central to that understanding is a single concept called **fan-out**.

{{< definition icon="FO" term="Fan-out" >}}
The number of children a single tree node can point to. A node with high fan-out has many children, producing a wide, shallow tree. A node with low fan-out has few children, producing a narrow, deep tree. On disk, depth is the enemy: every level of depth costs one more page read.
{{< /definition >}}

With fan-out defined, the failures of the alternatives become precise rather than vague.

{{< definition icon="BST" term="Binary Search Tree (BST)" >}}
The classic recursive structure taught in every algorithms course. Each node holds one key and two child pointers. Searching is O(log₂ n), which sounds efficient until you confront disk I/O.
{{< /definition >}}

In a naively stored BST, each node is likely to occupy a different page. Finding any single row on 1 billion rows could therefore require **30 separate page reads**. On an HDD at 10 ms per seek, that is **300 milliseconds per lookup**. No database engineer would accept this.

The root problem is fan-out: a BST has a fan-out of exactly 2. This forces the tree tall and thin, maximizing the number of page reads required per traversal. The B-tree's entire design is a direct assault on this number.

{{< definition icon="HM" term="Hash Map" >}}
Provides O(1) average-case lookup by mapping keys through a hash function to a bucket. Extremely fast for exact-match queries, but fundamentally incompatible with how databases are actually queried.
{{< /definition >}}

Hash maps fail databases for three structural reasons. First, they provide **no ordering**. A hash map cannot answer `WHERE price BETWEEN 10 AND 50` without scanning every bucket. Second, when the map grows beyond its allocated space, **resizing** requires rehashing and physically rewriting enormous amounts of data, a catastrophic I/O event. Third, they cannot support **prefix queries** like `LIKE 'abc%'` because the hash of `'abc'` has no relationship to the hash of `'abcd'`.

{{< callout title="Why hash indexes exist but remain niche" type="info" >}}
PostgreSQL and MySQL do support hash indexes for specific equality workloads. But they are a narrow optimization for a narrow case. The moment you need range queries, sorting, or prefix matching (the bread and butter of relational databases), hash indexes are useless. B-trees handle all of it.
{{< /callout >}}

The contrast becomes stark when you lay the structures side by side:

<table class="compare-table">
  <thead>
    <tr>
      <th>Characteristic</th>
      <th>BST</th>
      <th>Hash Map</th>
      <th>B-Tree</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Search complexity</td>
      <td><span class="tag bad">O(log₂ n)</span></td>
      <td><span class="tag good">O(1) avg</span></td>
      <td><span class="tag good">O(log_f n)</span></td>
    </tr>
    <tr>
      <td>Range queries</td>
      <td><span class="tag neutral">Possible</span></td>
      <td><span class="tag bad">Impossible</span></td>
      <td><span class="tag good">Excellent</span></td>
    </tr>
    <tr>
      <td>I/O efficiency</td>
      <td><span class="tag bad">Poor</span></td>
      <td><span class="tag neutral">Moderate</span></td>
      <td><span class="tag good">Superior</span></td>
    </tr>
    <tr>
      <td>Sequential scan</td>
      <td><span class="tag neutral">In-order traversal</span></td>
      <td><span class="tag bad">Impossible</span></td>
      <td><span class="tag good">Native leaf scan</span></td>
    </tr>
    <tr>
      <td>Disk page alignment</td>
      <td><span class="tag bad">None</span></td>
      <td><span class="tag neutral">Partial</span></td>
      <td><span class="tag good">Designed for it</span></td>
    </tr>
  </tbody>
</table>

---

{{< section-label >}}The Architecture{{< /section-label >}}

## What Makes a B-Tree a B-Tree

Rudolf Bayer and Edward McCreight invented the B-tree in 1970 at Boeing Research Labs. (What the "B" stands for has never been officially settled; balanced, broad, Boeing, and Bayer are all plausible candidates. Bayer himself declined to clarify.) The structure was designed from first principles around the constraints of disk-based storage. Its core insight was elegant: if the bottleneck is the number of page reads, build a tree so wide and so shallow that traversal requires only a handful of them.

The way it achieves this is by dramatically increasing fan-out. A BST node holds one key and two child pointers. A B-tree node, sized to fit a database page (8-16 KB), can hold hundreds or thousands of keys, giving it a fan-out in the hundreds or thousands. This is the single property that makes everything else work.

The structure of a B-tree node is straightforward. Each internal node stores up to *m - 1* **routing keys** (values used to decide which child pointer to follow) and up to *m* **child pointers**. Leaf nodes store the actual data pointers (or the rows themselves, in a clustered index). The tree remains balanced at all times: every path from root to leaf is the same length.

The mathematical consequence of high fan-out is dramatic:

$$h \approx \log_f(n)$$

Where *h* is the tree height, *f* is the fan-out, and *n* is the number of rows. With a fan-out of 1,000:

- Height 1 → up to 1,000 rows
- Height 2 → up to 1,000,000 rows
- Height 3 → up to 1,000,000,000 rows

**A B-tree on one billion rows requires at most 3-4 page reads to find any single row.** Even if every page read hits cold storage on an SSD, the entire lookup completes in under a millisecond.

{{< diagram src="btree" caption="Standard B-Tree: internal nodes hold routing keys and child pointers. Leaf nodes hold data pointers. Every path from root to leaf is the same length." >}}

This is why the B-tree doesn't just beat the BST. It renders the BST's disk-based performance so catastrophically worse that the comparison is almost unfair. The BST requires 30 page reads for 1 billion rows. The B-tree requires 3.

---

{{< pillars >}}
{{< pillar num="01" title="Physical Block Alignment: nodes are sized to match the hardware" >}}
B-tree node size is tuned to match the database page size, maximizing the number of keys retrieved per I/O operation and eliminating wasted reads.
{{< /pillar >}}
{{< pillar num="02" title="Maximized Fan-out: extreme shallowness by design" >}}
Hundreds of keys per node means billions of rows are reachable in 3-4 page reads. Depth grows logarithmically; performance barely changes as data scales.
{{< /pillar >}}
{{< pillar num="03" title="Sorted Locality: range scans become sequential I/O" >}}
Because keys are sorted within nodes and leaf nodes are linked, a range query reads contiguous pages rather than chasing random pointers, which is exactly what both HDDs and SSDs perform best at.
{{< /pillar >}}
{{< /pillars >}}

---

{{< section-label >}}The Evolution{{< /section-label >}}

## The B+ Tree: The Variant That Actually Runs Your Database

The structure described above is the classic B-tree. What PostgreSQL, InnoDB, Oracle, and SQL Server actually implement is a refinement called the **B+ tree**, and the differences matter in practice.

In a pure B-tree, internal nodes can hold data pointers alongside routing keys. In a B+ tree, this is prohibited: **internal nodes hold routing keys only**, and **all actual data lives exclusively in the leaf nodes**. The leaf nodes are then linked together in a doubly-linked list.

This separation produces two meaningful benefits. First, internal nodes become denser: without data pointers consuming space, each node fits more routing keys, which increases fan-out and further reduces tree height. Second, and more importantly, **range queries become simple sequential scans**.

{{< callout title="Why linked leaves change everything for range queries" >}}
Consider a query for all transactions between January 1 and January 31. With a pure B-tree, you'd descend to the first matching leaf, retrieve its data, then need to re-traverse the tree from the root to find the next matching node. With a B+ tree, you descend once, find the starting leaf, then follow the linked list forward through all matching leaves. One descent, then pure sequential I/O. This is why B+ trees dominate OLTP storage engines.
{{< /callout >}}

{{< diagram src="bplus" caption="B+ Tree: internal nodes contain only routing keys. Leaf nodes contain all data pointers and are connected in a sorted linked list, enabling sequential range scans without re-traversal." >}}

---

{{< section-label >}}Clustered vs. Secondary{{< /section-label >}}

## Two Flavors of Index: Where the Row Actually Lives

Now that we understand the tree's shape, it's worth asking what exactly lives in its leaf nodes. That choice has significant consequences for query performance.

Not all B-tree indexes are equal. The distinction between **clustered** and **secondary** indexes is one of the most consequential architectural differences in relational databases, and it is still confused by many developers.

{{< definition icon="CI" term="Clustered Index" >}}
An index in which the leaf nodes of the B-tree *contain the full row data* (not a pointer to the row, but the actual columns). The physical order of rows on disk matches the index order. In InnoDB, every table has exactly one clustered index (the primary key). PostgreSQL uses the term "heap table" for its default storage and provides `CLUSTER` to reorder on demand.
{{< /definition >}}

{{< definition icon="SI" term="Secondary Index" >}}
Any index other than the clustered index. Leaf nodes store the indexed column value alongside the **primary key** of the matching row, not the full row. Retrieving a full row from a secondary index therefore requires two lookups: first descend the secondary B-tree to find the primary key, then descend the primary B-tree (or heap) to retrieve the row. This is called a **double lookup** or, in MySQL terminology, a **bookmark lookup**.
{{< /definition >}}

{{< callout title="The performance implication of secondary indexes" type="error" >}}
An `INDEX` on `(email)` for a login query is nearly instant, requiring one B-tree descent. But the same query with `SELECT *` forces a second lookup into the clustered index for every matching row. If your query is reading thousands of rows via a secondary index, those thousands of double lookups add up. This is why `SELECT *` is genuinely expensive when used with non-covering secondary indexes.
{{< /callout >}}

The escape hatch is a **covering index**: an index that includes all the columns the query needs in its leaf nodes, eliminating the second lookup entirely.

{{< codeblock label="Double lookup - slow at scale" labeltype="bad" lang="sql" complexity="⚠ Secondary index finds the PK, then fetches the full row from the clustered index. Two B-tree descents per row." complexitytype="bad" >}}
-- Secondary index on (email) can find the row's PK fast,
-- but SELECT * forces a second lookup into the clustered index
SELECT * FROM users WHERE email = 'alice@example.com';
{{< /codeblock >}}

{{< codeblock label="Covering index - O(log n), single descent" labeltype="good" lang="sql" complexity="✓ All needed columns are in the index leaf. No second lookup required." complexitytype="good" >}}
-- With INDEX (email) INCLUDE (name, role), the leaf node
-- contains everything the query needs
SELECT email, name, role FROM users WHERE email = 'alice@example.com';
{{< /codeblock >}}

---

{{< section-label >}}The Internal Lifecycle{{< /section-label >}}

## What Happens Inside the Tree on Every Write

Understanding how a B-tree responds to writes clarifies both its performance characteristics and its operational costs.

**Insertion** follows a straightforward path: descend to the correct leaf, write the key. When a leaf is full, it **splits**: the median key is promoted up to the parent, the node divides into two, and both are written. If the parent is also full, it splits too, and the cascade propagates upward, potentially all the way to the root. When the root splits, a new root is created and the tree grows one level taller. In practice, this is rare: production trees have enough fan-out that root splits are infrequent.

**Deletion** is more nuanced. The mathematically correct behavior (merging under-full nodes after deletion) is often **deliberately deferred** or approximated in production engines. This is because merge-on-delete creates oscillation: a table near a merge threshold that alternates between inserts and deletes would trigger constant page merges and splits. Most engines instead allow pages to fall slightly below their theoretical minimum occupancy, accepting mild storage inefficiency in exchange for write stability.

{{< callout title="Page splits and the WAL" type="info" >}}
Every page split generates multiple Write-Ahead Log (WAL) entries. The WAL is the journal your database uses to make writes crash-safe: changes are recorded there first, before the actual data pages are modified. A split touches at least three pages (the original node, the new sibling, and the parent), so each split produces at least three WAL records. This is normal and expected. But it is also why extremely write-heavy workloads on narrow integer keys (like auto-increment IDs) are B-tree-friendly: new rows always append to the rightmost leaf, triggering far fewer splits than random UUID inserts, which scatter writes across the entire tree and cause constant splitting.
{{< /callout >}}

**The UUID problem deserves a dedicated note.** When you use random UUIDs as primary keys, each new insert lands at a random position in the key space, forcing the engine to load a different leaf page from disk for nearly every write. This also means pages are constantly being split rather than filled sequentially. The practical consequence: UUID primary keys can measurably degrade write throughput on large InnoDB tables compared to sequential integer keys. Teams that need globally unique identifiers but care about write performance often reach for **UUIDv7** (which is time-ordered and therefore sequential) or a surrogate integer key instead.

**Page splits also have a longer-term consequence for reads.** Over time, after many splits, the logical ordering of leaf pages in the linked list may no longer match their physical ordering on disk. What was designed to be sequential I/O for a range scan can degrade into random I/O as the physical layout diverges from the logical one. This fragmentation is real and accumulates silently. It is precisely why database maintenance operations like PostgreSQL's `VACUUM`, MySQL's `OPTIMIZE TABLE`, and manual index rebuilds exist: they restore physical page order, turning degraded random I/O back into the sequential I/O the B-tree was designed to produce.

---

{{< section-label >}}Where B-Trees Stop{{< /section-label >}}

## The One Problem B-Trees Cannot Solve

For all their dominance, B-trees are not universal. There is one class of workload where they degrade gracefully but fundamentally: **high-dimensional similarity search**.

A B-tree's sorting guarantee is one-dimensional. A key either comes before or after another key. But when you're searching for "the 10 vectors most similar to this embedding" across a 1,536-dimensional space (the default for many modern embedding models), there is no meaningful linear ordering. No matter how you project the data into a B-tree, the result is a structure where "nearby" vectors in high-dimensional space are scattered randomly across the tree's leaves.

{{< callout title="The curse of dimensionality" type="error" >}}
Think of it this way: imagine trying to alphabetically sort people by "personality." The sorting key simply doesn't capture proximity in the space that matters. In 1,536 dimensions, two vectors that are semantically close (say, embeddings for "cat" and "kitten") may be nowhere near each other when their values are projected onto a single number line. A query for similar vectors would therefore need to explore an exponentially growing fraction of the tree, eliminating the logarithmic advantage entirely. For this reason, vector databases use fundamentally different structures: HNSW graphs, IVF indexes, or product quantization, all of which navigate high-dimensional space probabilistically rather than with binary comparisons.
{{< /callout >}}

This is not a failure of the B-tree. It is a boundary condition. B-trees were designed for ordered, one-dimensional keys. For everything from integer IDs to timestamps to UUIDs to composite keys, they remain unmatched. For semantic similarity in embedding space, a different tool is required.

---

{{< section-label >}}Does NVMe Change This?{{< /section-label >}}

## The B-Tree in the Age of Fast Storage

A reasonable question: if NVMe SSDs are fast enough to make random I/O nearly cheap, does the B-tree's page-minimization advantage shrink to irrelevance?

The answer is no, and the most important reason is the **buffer pool**: the database's page cache in RAM. PostgreSQL calls this `shared_buffers`; InnoDB calls it the buffer pool. Because the B-tree's structure guarantees that upper-level pages are accessed on *every* query, those pages are almost never read from disk at all. They simply live in RAM permanently once warmed up. Leaf pages, accessed less often, are evicted and loaded as needed.

This tiered access pattern is not accidental. It is a direct consequence of the B-tree's logarithmic structure, and it is one reason the B-tree's performance model remains predictable even as underlying storage gets faster. A well-sized buffer pool on a busy OLTP system will have the top two or three levels of every major index perpetually cached, meaning most queries pay for only one or two actual disk reads: the final descent into the leaf. This is why database servers are often given as much RAM as possible.

---

{{< section-label >}}Putting It Together{{< /section-label >}}

## What This Means for the SQL You Write Every Day

The B-tree's geometry has direct, practical consequences for query performance, consequences you can exploit once you understand the structure. And you can observe these consequences directly in your database's query planner output.

When PostgreSQL or MySQL evaluates a query, it chooses between execution strategies like `Seq Scan` (read every page in the table), `Index Scan` (descend the B-tree, fetch full rows), and `Index Only Scan` (descend the B-tree, return data directly from leaf nodes without touching the heap). These aren't arbitrary labels: they map exactly to the B-tree operations described above. An `Index Only Scan` is the planner telling you a covering index is being used. An `Index Scan` means a double lookup is happening. A `Seq Scan` on a table with a relevant index often means the query touches enough rows that the planner judges a full table scan cheaper than thousands of individual B-tree descents.

Understanding the tree makes these plan choices legible rather than mysterious.

**Range queries are cheap because of sorted leaf ordering.** A query like `WHERE created_at BETWEEN '2025-01-01' AND '2025-01-31'` descends the tree in O(log n) to find the starting leaf, then follows the linked list forward until the range is exhausted. The I/O is sequential, which is the best-case access pattern for any storage medium.

{{< codeblock label="Range scan - O(log n) + sequential I/O" labeltype="good" lang="sql" complexity="✓ B-tree descent to the start of the range, then sequential leaf traversal. Cost is proportional to the range size, not the table size." complexitytype="good" >}}
SELECT *
FROM transactions
WHERE transaction_date BETWEEN '2025-01-01' AND '2025-01-31'
ORDER BY transaction_date ASC;
{{< /codeblock >}}

**Prefix queries are cheap because of sorted key ordering.** `WHERE name LIKE 'Smith%'` can use a B-tree index on `name` because `'Smith...'` corresponds to a contiguous range in the sorted key space. `WHERE name LIKE '%Smith'` cannot, since a trailing wildcard has no range interpretation in a sorted structure, and the planner will fall back to a sequential scan.

**`ORDER BY` can be free when it matches an index.** If the B-tree index on `created_at` already returns rows in sorted order, and your query orders by `created_at`, the optimizer can satisfy the sort by reading the index's leaves in order, with no additional sorting step required. This is one of the most commonly overlooked performance benefits of well-chosen index key ordering.

**Composite index column order is not arbitrary.** An index on `(status, created_at)` is sorted first by `status`, then by `created_at` within each status value. This means it can efficiently serve a query filtering on `status` alone, or one filtering on both `status AND created_at`. It **cannot** efficiently serve a query filtering on `created_at` alone: without a `status` filter to anchor the search, the engine would need to scan the entire index to find matching dates scattered across different status partitions.

{{< codeblock label="Composite index - leading column missing" labeltype="bad" lang="sql" complexity="⚠ The (status, created_at) index cannot be used here. 'created_at' is not the leading column. Expect a sequential scan." complexitytype="bad" >}}
-- This does NOT use an index on (status, created_at)
-- No leading column filter to anchor the B-tree descent
SELECT * FROM orders WHERE created_at > '2025-01-01';
{{< /codeblock >}}

{{< codeblock label="Composite index - leading column present" labeltype="good" lang="sql" complexity="✓ Both columns in the index are used. B-tree descends on 'status', then scans the 'created_at' sub-range within that partition." complexitytype="good" >}}
-- This DOES use the (status, created_at) index efficiently
SELECT * FROM orders WHERE status = 'pending' AND created_at > '2025-01-01';
{{< /codeblock >}}

The rule is: a composite index is only usable for a **prefix** of its defined columns. Think of it as the tree's first-level sort order: if you don't filter on that first column, you have no anchor point in the tree, and the advantage of sorted storage evaporates.

---

{{< conclusion title="The Algorithm That Matches Its Medium" label="Conclusion" >}}
The B-tree has outlasted decades of hardware revolutions, from magnetic drums to spinning platters to NAND flash to NVMe, not because it was the first structure tried, but because it was designed from first principles around the constraints that have never changed: storage is hierarchical, block I/O is the bottleneck, and the only way to make lookups fast is to minimize the number of pages a traversal must touch.

Its geometry (wide, shallow, sorted, self-balancing) is a direct answer to the physics of persistence. Its fan-out turns billions of rows into a 3-level tree. Its sorted leaves turn range queries into sequential I/O. Its self-balancing property guarantees that performance never degrades as data grows. Its per-page node sizing ensures every disk read is fully utilized.

Understanding the B-tree is not an academic exercise. It is the foundation on which every index, every query plan, and every storage engine decision rests. When you choose an index key ordering, decide whether to use a covering index, wonder why `LIKE '%suffix'` doesn't use your index, or puzzle over why a query plan switched from `Index Scan` to `Seq Scan` after a table grew, you are working with the consequences of decisions made in 1970 that have proven correct for five decades.

**The database that runs your application is, in very large part, a collection of B-trees. Understanding what they are and why they are built the way they are is the single most leveraged piece of database knowledge a backend engineer can have.**
{{< /conclusion >}}