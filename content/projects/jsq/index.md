---
title: "BigJSON: A Viewer That Opens<br>Gigabytes of JSON Without Loading Them"
subtitle: "No open-source viewer on my Mac could open the multi-gigabyte JSON files I worked with — so I built one. A read-only desktop viewer and a SQL-shaped query CLI, over a Rust engine that never loads the file into memory."
date: 2026-06-07
author: "Imloul Anas"
status: "active"
repo: "https://github.com/AnasImloul/jsq"
tags: ["rust", "json", "query-engine", "streaming", "mmap"]
math: true
---

I kept hitting the same wall: I had JSON files several gigabytes in size, and nothing on my Mac could just *open* them. IDEs choke on them — and when one does limp a large file open, all it gives you is read-only plain text: no structure, no navigation, no search worth the name. The dedicated viewers people point to are commercial; the most-cited one, Dadroit, caps its free tier at around 50 MB, which is nothing next to a multi-gigabyte dump.

So I built **BigJSON**: a free, open-source, cross-platform JSON viewer that opens multi-GB files, lets you browse the structure, search and query it, and export the results — read-only, fast, and not bound by file size. A second tool fell out of the same core: **jsq**, a SQL-shaped command-line query language for those same files.

Both are thin frontends over one Rust engine, and the engine has a single trick that makes all of it possible: **it never loads the file into memory.** Here's a number that captures the wall everything else hits — run `jq` over a 1 GB file to count a few matching rows and it eats roughly **17 GB of RAM**, because it first parses the whole document into a heap tree. That same model is why IDEs and viewers fall over on large files. BigJSON's engine memory-maps the file and builds a compact index instead, so it opens a gigabyte while holding tens of megabytes. This is how.

---

{{< section-label >}}The Problem{{< /section-label >}}

## Why a Gigabyte of JSON Costs You Sixteen

`jq` is a per-token stream *processor*, but to evaluate a filter it first materializes the document into an in-memory tree: every object becomes a hashmap, every array a vector, every number and string a heap-allocated, reference-counted value. That representation is convenient — you can walk it, reshape it, index into it freely — but it's bulky. A JSON number that occupies three bytes on disk becomes a tagged, boxed value many times that size once it's a node in a tree.

Measured end to end, the parsed form lands at roughly **16× the file size**. A 1 GB file becomes ~16 GB of live heap, and that holds whether you use `jq` (C) or `jaq` (a tight Rust rewrite). The language and the implementation language don't matter here. The *model* does.

{{< definition icon="DOM" term="Parse-to-heap (the DOM tax)" >}}
The approach `jq`, `jaq`, and most JSON libraries take: read the whole document and build a tree of boxed values in memory before any query runs. Convenient for arbitrary reshaping, but peak memory scales with the input size, not the output size — so a query that returns one number off a 1 GB file still pays for 1 GB (×16) of resident tree.
{{< /definition >}}

For range scans and projections that emit a row per input element, holding everything is sometimes unavoidable. But the queries that dominate real data work — *count the paid orders, sum revenue per region, join events to users and total by tier* — collapse millions of rows down to a handful. Paying gigabytes to produce three group rows is pure overhead. That gap is the entire opportunity.

---

{{< section-label >}}The Bet{{< /section-label >}}

## One Query, One Streaming Pass

The design premise of the query language is narrow on purpose: you don't get a Turing-complete transformation language. You get **one query**, shaped like SQL, that runs in a single pass and prints NDJSON. It's what the CLI speaks, and it's the language behind the viewer's query bar.

{{< codeblock label="Shell" labeltype="neutral" lang="bash" >}}
# Count the paid orders
jsq orders.json 'from .orders[] as o where o.status == "paid" aggregate { n: count() }'

# Revenue per region, top 5
jsq orders.json 'from .orders[] as o
  aggregate { revenue: sum(o.total) } by o.region
  order by .revenue desc
  limit 5'
{{< /codeblock >}}

Every query emits **one JSON value per line**, so the output still composes with the tools you already use — `jsq … | jq …`, `| head`, `| wc -l`. jsq doesn't replace `jq`; it sits upstream of it, doing the heavy GB-scale reduction that `jq` would choke on, and hands the small result downstream.

The grammar is a fixed clause pipeline. Clauses are optional except `from`, but their order is fixed — which is exactly what makes single-pass evaluation tractable:

{{< definition icon="SQL" term="The clause pipeline" >}}
`from PATH as ALIAS` (required) → `join … on L == R` → `unnest EXPR as ALIAS` → `where PREDICATE` → `let` bindings → `distinct` → `aggregate { … } by KEY` → `having PREDICATE` → `select { … }` → `order by EXPR` → `limit N`. Paths use `.field`, `[N]`, and `[]` to iterate; there's no `.[]` or `*`. The whole reference, with worked examples for every clause, lives in <a href="https://github.com/AnasImloul/jsq/blob/main/docs/QUERY.md" target="_blank" rel="noopener noreferrer">docs/QUERY.md</a>.
{{< /definition >}}

If you think in SQL, pandas, or list comprehensions, the mapping is direct: `for x in arr` is `from .arr[] as x`, `filter` is `where`, `groupBy + reduce` is `aggregate … by`, `flatMap` is `unnest`, `DISTINCT ON` is `distinct by`. The point of constraining the language is that every one of those clauses can be evaluated as the stream flows past, without ever holding the stream.

---

{{< section-label >}}The Architecture{{< /section-label >}}

## Two Frontends, One Engine

The primary product is **BigJSON**, a cross-platform desktop viewer (Tauri + Svelte). It opens a multi-GB file behind a streaming progress bar, then lets you explore it read-only: a collapsible tree navigator with breadcrumbs, text search across the document, an in-app query bar running the same jsq language, and CSV/JSON export of results. Rows are virtualized, so scrolling a gigabyte stays smooth — the UI only ever holds the handful of rows actually on screen.

The `jsq` CLI is the secondary frontend — a thin Rust binary that pipes NDJSON for shell composition. Both delegate every semantic decision and every byte of output to the same Rust engine crate.

{{< diagram src="engine" caption="Two frontends, one engine. The desktop viewer and the CLI both link the Rust engine directly (the desktop app via its src-tauri Rust bridge — it calls the engine's flat function surface as ordinary Rust, no C-ABI marshaling). Every feature — a new operator, a new output format — is a one-place change in the engine." >}}

That parity is a deliberate constraint, not an accident. Because the desktop app links the engine as a normal Rust crate rather than reimplementing anything in TypeScript, there is exactly one parser, one evaluator, one renderer. The viewer's tree navigator is the clearest payoff: it never holds the JSON tree in JavaScript — it asks the engine for one level of children at a time over the memory-mapped index (a batched call into the engine's child-iteration API), so expanding a node in a 10 GB file is a few page faults, not a load. And a query behaves identically in the CLI and the UI because it is literally the same code path.

---

{{< section-label >}}The Query Path{{< /section-label >}}

## From Text to NDJSON

A query string becomes results through four stages. The split between a *surface* AST and an *engine* AST is the load-bearing decision here: the surface form mirrors the SQL-shaped syntax a human writes, and a lowering pass rewrites it into a smaller set of primitive operators the evaluator knows how to stream.

{{< diagram src="pipeline" caption="The query compilation path. The lexer and recursive-descent surface parser produce an AST that mirrors the written clauses; lowering rewrites it into the engine's primitive operators; the push-based evaluator walks that and emits NDJSON. `jsq --explain` stops after lowering and prints the engine AST without touching the data file." >}}

Lowering is where the syntactic sugar dissolves. An aggregate item like `revenue: sum(o.total) * 1.1` isn't a single operation — the lowerer detects the `sum(...)` reducer buried inside the arithmetic, hoists it into a dedicated reduction slot, and rewrites the output expression to multiply *that slot* by 1.1. Field-set macros expand, `let` bindings get substituted into the aggregate block, and `from .events[]` becomes a primitive iterate-over-children operator. By the time the evaluator runs, there's no SQL left — just a tree of stream operators.

The evaluator itself is **push-based**. Instead of pulling values through a chain of iterators, `walk_eval` dispatches on the operator and calls a sink closure for each value it emits:

{{< codeblock label="The evaluator sink" labeltype="neutral" lang="rust" >}}
fn walk_eval(
    // ...
    sink: &mut dyn FnMut(Value) -> bool,
) { /* ... */ }
{{< /codeblock >}}

{{< definition icon="PUSH" term="Push-based evaluation" >}}
Each operator drives values *downstream* by calling a sink, rather than being pulled by a consumer. The sink returns a `bool`; returning `false` means "stop, I have enough." This gives early termination for free — once a `limit 5` has seen its fifth row, the signal propagates back up and the source stops scanning. Stateful operators (reducers, sort, distinct) intercept the stream and buffer only what they must.
{{< /definition >}}

That early-termination signal matters more than it looks. A `limit` after a sort doesn't just trim the output — it bounds how much the sort has to keep (more on that below), and a `limit` over a plain scan stops the file walk the instant the quota is met.

---

{{< section-label >}}The Memory Model{{< /section-label >}}

## Memory-Mapped, Not Heap-Allocated

Here is the core trick, and it's the whole reason the memory numbers look the way they do. jsq never reads the JSON file into a buffer. It **memory-maps** it, and it builds an **offset index** — a sidecar file — that it also memory-maps.

{{< diagram src="memory" caption="Two ways to spend memory on a 1 GB file. jsq maps the source and a compact index sidecar; the kernel faults pages in as the scan touches them and reclaims them under pressure, so owned RAM stays flat at tens of MiB. jq and jaq parse the whole document into the heap — dirty, non-reclaimable, ~16× the file size." >}}

{{< definition icon="MMAP" term="Memory-mapped file + sidecar index" >}}
`mmap` maps a file's bytes into the process's address space without copying them into the heap. The pages are *clean* and *file-backed*: the kernel pages them in on demand as you touch them, and can drop them again under memory pressure without swapping. jsq parses the JSON once into a `.jsonidx` sidecar — a flat array of fixed-size records describing each node's position — and memory-maps that too. Both the source and the index are reclaimable; neither lives on the heap.
{{< /definition >}}

The consequence is that the engine's *owned* memory tracks the working set, not the file size. Scanning the gigabyte to compute a sum touches the index records sequentially, the kernel keeps a small window of pages resident, and the resident footprint stays flat. It also means the engine can work on files **larger than physical RAM** — something the parse-everything approach simply cannot do, because you can't put 64 GB of parsed tree into 32 GB of heap.

This is also what makes the viewer feel instant: opening a file maps it and builds the index rather than reading it into a buffer, and scrolling pulls only the visible rows' records off the mmap. BigJSON opens files that wouldn't fit in RAM at all — which is exactly the case where IDEs give up.

This does produce a measurement subtlety worth being honest about:

{{< callout title="Two memory numbers, and which one is honest" type="info" >}}
jsq's **RSS** (resident set size) looks large — gigabytes at 1 GB — because it counts the memory-mapped source and index pages faulted in during the scan. But those pages are *clean and reclaimable*: the kernel can evict them for free. The number that reflects what jsq truly needs is **phys_footprint** — the dirty, owned memory, the figure Activity Monitor shows. That stays at 34–36 MiB. For `jq` and `jaq` the two numbers are nearly identical, because it's all dirty heap. The gap between RSS and footprint *is* the streaming architecture, made visible.
{{< /callout >}}

---

{{< section-label >}}The Index{{< /section-label >}}

## A Pre-Order Array of Records

The sidecar isn't a tree of pointers — it's a flat array of fixed-size records in **pre-order** (depth-first, parent before children). Each record is 48 bytes:

{{< codeblock label="NodeRecord — 48 bytes, repr(C)" labeltype="neutral" lang="rust" >}}
#[repr(C)]
pub struct NodeRecord {
  offset: u64,        // byte position in the source mmap
  length: u64,        // source byte span of the value
  key_or_index: u64,  // object: offset into the keys arena; array: slot index
  parent: u32,
  subtree_size: u32,  // records in this subtree, including self (always >= 1)
  child_count: u32,   // direct children, primitives included
  key_length: u32,
  kind: u8,           // Null | Bool | Number | String | Array | Object
  flags: u8,
}                     // + 6 bytes padding -> 48, 8-byte aligned
{{< /codeblock >}}

Two invariants fall out of the pre-order layout, and the rest of the engine leans on both.

{{< definition icon="PRE" term="The pre-order subtree invariant" >}}
For any record at index `k` with `subtree_size = n`, the records `[k+1 .. k+n]` are *exactly* the descendants of `k`, in source order. A whole subtree is therefore a contiguous slice — cache-friendly to scan — and the next sibling of `k` sits at `k + subtree_size`. No `next_sibling` or child-list pointers are stored; they're arithmetic. (Debug builds re-verify this invariant after every parse.)
{{< /definition >}}

The second decision is what *gets* a record at all. Emitting one record per JSON value would make the index enormous and mostly redundant — a flat object of ten small fields would cost ten records plus itself. So jsq uses a **hybrid emit-gate**:

{{< definition icon="GATE" term="The hybrid emit-gate" >}}
Records are emitted only for **containers** (objects and arrays) and for **strings whose source span is ≥ 256 bytes** (`FAT_STRING_THRESHOLD`). Small primitives — numbers, booleans, nulls, short strings — get no record. They live only in the source bytes and are reconstructed on demand: when iterating a container's children, the evaluator walks the container's source span in lockstep with the chain of skippable records, parsing inline primitives as it goes. Fewer records, a smaller index, and the common case (objects full of small scalars) stays cheap.
{{< /definition >}}

So `child_count` and `subtree_size` measure genuinely different things, and the struct keeps both: a container can have ten direct children but a `subtree_size` that only counts the nested containers among them, because the scalar children never became records.

{{< callout title="Why a flat pre-order array beats a pointer tree here" type="info" >}}
A pointer-based tree scatters nodes across the heap, so a traversal of 20 nodes can mean 20 cache misses. The pre-order array stores a subtree as a contiguous run of 48-byte records, so scanning descendants is a linear sweep the prefetcher loves. And because it's a flat array in a memory-mapped file, "loading" a subtree is just faulting in a few contiguous pages — not chasing pointers through gigabytes of address space.
{{< /callout >}}

---

{{< section-label >}}Joins{{< /section-label >}}

## Joining Without Materializing

A join is the classic way to blow up memory — the naive version materializes the cross product. jsq doesn't. When a query joins on `u.user_id == e.user_id`, the engine builds a **foreign-key index**: a hashmap from each key value to the record IDs that carry it.

{{< codeblock label="Inner join + group-by" labeltype="neutral" lang="sql" >}}
from .events[] as e
join .users[] as u on u.user_id == e.user_id
aggregate { revenue: sum(e.amount) } by u.tier
order by .tier
{{< /codeblock >}}

Internally that index is a `HashMap<ScalarKey, Vec<u32>>`, built once per join and cached on the document. `ScalarKey` is a compact, hashable encoding of a JSON scalar — distinguishing integral from fractional numbers, interning the variants — so grouping and lookups never allocate a string per row. At runtime each event hashes its key once and gets the matching user records in $O(1)$, with no nested-loop scan and no joined rows held in memory.

This is why even a **two-hop** join (event → user → region) stays flat: it's two index lookups per event, both $O(1)$, neither materializing anything. In the benchmarks the chained join over 7 million events holds the same ~36 MiB as a bare count.

---

{{< section-label >}}Folding the Stream{{< /section-label >}}

## Why Reductions Stay Flat

The reason aggregates cost almost nothing is that they *fold the stream away as it flows*. A `sum … by region` keeps one accumulator per distinct region — a handful of entries — and updates them row by row. Millions of input rows in, three group rows out, and only the three group rows are ever resident.

Sorting is the operation that looks like it must buffer everything, and jsq avoids it whenever a `limit` follows:

{{< definition icon="TOPK" term="Limit-aware top-K sort" >}}
`order by … limit N` doesn't buffer the whole stream and sort it. It keeps a bounded max-heap of size $N$ whose root is the *worst* surviving row. Each incoming row is compared against the root; if it's better, it displaces the root, otherwise it's discarded. Memory is $O(N)$ regardless of stream length, and the cost is $O(M \log N)$ for $M$ rows instead of $O(M \log M)$.
{{< /definition >}}

`distinct` dedupes against a set of value fingerprints rather than retaining full rows. The recurring theme: every stateful operator buffers only what its *output* demands, never the input.

Which sets up the one honest exception:

{{< callout title="Projections that emit a row per input are the exception" type="warning" >}}
jsq's flat memory is a property of *reducing* queries. A query like `from .events[] as e where e.amount > 500 select { id, amount }` emits one row per surviving event — about 3.5 million of them at 1 GB — and jsq buffers the whole result set before printing. That query costs ~1.2 GB, and it scales with the *output* size, not the file size. The honest framing: jsq wins big on filters and aggregates that return little; for queries that return a lot of rows, every tool pays real memory.
{{< /callout >}}

---

{{< section-label >}}The Numbers{{< /section-label >}}

## jsq vs jq vs jaq

The benchmark suite runs nine queries — filter/project, counts, single- and multi-metric group-bys, single and chained joins, `unnest`, post-aggregate `having`, and a combined kitchen-sink — across 10 MB, 100 MB, and 1 GB files, against `jq` 1.7.1 and `jaq` 3.0.0. Including `jaq` is the point: it isolates the variable. `jq` vs `jaq` is *C vs Rust*; jsq vs both is *parse-everything vs streaming*.

Here is the group-and-sum query (`q3`) at all three sizes:

<table class="compare-table">
  <thead>
    <tr>
      <th>File</th>
      <th>jsq time</th>
      <th>jq time</th>
      <th>jaq time</th>
      <th>jsq RAM</th>
      <th>jq RAM</th>
      <th>jaq RAM</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>10 MB</td>
      <td><span class="tag good">0.26 s</span></td>
      <td>0.45 s</td>
      <td><span class="tag good">0.24 s</span></td>
      <td><span class="tag good">30 MiB</span></td>
      <td>167 MiB</td>
      <td>154 MiB</td>
    </tr>
    <tr>
      <td>100 MB</td>
      <td><span class="tag good">0.60 s</span></td>
      <td>3.81 s</td>
      <td>1.77 s</td>
      <td><span class="tag good">33 MiB</span></td>
      <td>1.7 GB</td>
      <td>1.5 GB</td>
    </tr>
    <tr>
      <td>1 GB</td>
      <td><span class="tag good">7.0 s</span></td>
      <td><span class="tag bad">69 s</span></td>
      <td>28 s</td>
      <td><span class="tag good">34 MiB</span></td>
      <td><span class="tag bad">17 GB</span></td>
      <td><span class="tag bad">15 GB</span></td>
    </tr>
  </tbody>
</table>

At 1 GB jsq is ~10× faster than `jq` and ~4× faster than `jaq` on this query, and holds **34 MiB against 15–17 GB** — a ~450–500× memory gap. The detail that proves the thesis is the `jaq` column: rewriting `jq` in Rust buys a real speedup (~1.5–2×) but moves the memory needle essentially zero, because `jaq` still parses everything. The frugality is the architecture, not the language.

{{< callout title="Where jq and jaq win" type="info" >}}
On a few-megabyte file, `jq` and `jaq` are competitive or faster on simple queries — the whole job finishes before jsq's index build pays off, and they bring a far richer transformation language. Reach for jsq when files are large and the query reduces; reach for `jq`/`jaq` for quick hits on small files and arbitrary reshaping. The benchmark doc is deliberate about this — it's not a strawman.
{{< /callout >}}

---

{{< section-label >}}The Trade-offs{{< /section-label >}}

## What jsq Gives Up

Three honest costs come with the design.

{{< pillars >}}
{{< pillar num="01" title="A query, not a language" >}}
jsq runs one fixed-shape query. `jq` is Turing-complete and can express arbitrary transformations jsq simply can't. The constraint is what makes single-pass streaming evaluation possible — but it is a constraint.
{{< /pillar >}}
{{< pillar num="02" title="Index build cost up front" >}}
The first query on a file pays to parse it into the sidecar. On small files that cost dominates, which is exactly why `jq`/`jaq` win there. The investment amortizes over large files and repeated queries in a desktop session.
{{< /pillar >}}
{{< pillar num="03" title="Projections still cost RAM" >}}
The flat-memory guarantee is for *reducing* queries. A query that emits a row per input buffers its whole result set. jsq's edge is on the filter-and-aggregate workloads that dominate analytics, not on full-document reshaping.
{{< /pillar >}}
{{< /pillars >}}

---

{{< conclusion title="The Memory Win Is the Architecture" label="Conclusion" >}}
The thing I keep coming back to is the `jaq` result. A meticulous Rust rewrite of `jq` runs faster but needs the same 15 GB, because it makes the same bet: parse the whole document, then query it. jsq makes the opposite bet — memory-map the file, build a compact pre-order index, and fold the query into the stream as it scans — and the payoff is a 450× memory reduction that a faster language could never buy.

That's the whole lesson. When a workload is dominated by *reduction* — counting, summing, grouping, joining millions of rows down to a few — the question isn't "how fast can I parse this?" It's "do I have to parse all of it at all?" The answer is no, and tens of megabytes is what that answer costs.

And it turns out the original goal — open a multi-gigabyte JSON file on a laptop and actually *explore* it — is the same problem wearing different clothes. A viewer that scrolls a 10 GB file and a CLI that sums it in 34 MiB are two faces of one decision: never load what you don't need.
{{< /conclusion >}}
