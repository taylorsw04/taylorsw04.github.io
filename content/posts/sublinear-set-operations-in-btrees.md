<!-- Edit the writing below. Keep {#anchor} suffixes when renaming headings to preserve links. -->

# Sub-linear set operations in B+ trees {#b-plus-set-operations}

## TL;DR {#tldr}

I recently implemented fast versions of [set operations](https://en.wikipedia.org/wiki/Algebra_of_sets) in the only widely-used [b-tree library on NPM](https://www.npmjs.com/package/sorted-btree) (I am one of two co-authors). I spent some time poking around the internet and literature and failed to find any examples of implementations with sublinear bounds, so I decided it would be both useful and fun to publish a write-up of how I did it. This is also an exploration in AI-assisted pedagogy originating out of frustration with how abysmal current models are at following the "intuitional river" that makes for truly good explanations. All writing and mistakes are my own, all diagrams are my agent's.  

## Primer: B-trees are Best-trees {#primer}

> Note: If you are familiar with B-trees and already love them, you can jump to [the next section](#cheap-cloning).

A colleague of mine once told me that if he were stranded on a desert island and could only bring one data structure, it would be the B-tree. He was right about many things, and this was undoubtedly one of them: B-trees are criminally underrated. Most of us learned about these versatile trees (if they were covered at all) in the context of databases. [Wikipedia's article](https://en.wikipedia.org/wiki/B-tree) is no exception, couching them in a primarily disk-centric light. It is certainly true that B-trees have characteristics that make them a fantastic fit for disk-intensive workloads...but they have so much more to offer!

One of the primary aspects of B-trees that make them great fits for disks is their high branching factors, often **several hundred or more**, which results in large numbers of keys and values living in contiguous blocks. Indeed, the branching factor is often selected such that node blocks align with disk blocks, ensuring that operations perform a minimal number of disk reads. This optimization is incredibly important for workloads in which the cost of navigating between nodes (a disk read) dominates the cost of searching for keys in those nodes (usually done via binary search, since the keys are sorted). However, modern cache architecture, the rise of in-memory databases, and generally more memory-intensive workloads mean that all of *those same benefits apply to in-memory B-trees*.

Even for scenarios in which [cache](https://dl.acm.org/doi/fullHtml/10.1145/3592980.3595316)/disk alignment is irrelevant, B-trees offer a number of major advantages over other search trees (or even a hashtable):
1. Compared to other self-balancing search trees, they are significantly simpler and often much faster.
2. They support extremely fast range queries.
3. They can easily support O(1) cloning via copy-on-write, and even be converted into a [persistent](https://en.wikipedia.org/wiki/Persistent_data_structure) B-tree.

Their simplicity, in particular, makes B-trees great candidates for layering more advanced algorithms and structure on top of them. This is why, when [my current team](https://github.com/microsoft/FluidFramework) had need for sub-linear set operations (union, intersect, symmetric difference, etc.), I decided to implement them in the B-tree library.

Before jumping into the algorithms, a *very* brief recap on how these trees work.

### B-trees, plus or minus {#b-tree-recap}

From Wikipedia:
> In computer science, a B-tree is a self-balancing tree data structure that maintains sorted data and allows searches, sequential access, insertions, and deletions in logarithmic time. The B-tree generalizes the binary search tree, allowing nodes to have more than two children.

Before continuing, I should highlight that [the library](https://www.npmjs.com/package/sorted-btree) described in this post *isn't an actual B-tree*; rather, it's a B+ tree, which differs from a B-tree only in that interior nodes do not store values, and instead are only lookup indexes to navigate to children. The remainder of this article will describe B+ trees, but keep in mind that the differences are quite small and all of this transfers to B-trees without issue.

In the canonical B+ tree, the interior nodes store a sorted list of the minimum keys stored in each child, recursively, as well as pointers to those children. Navigation, which is the same in both queries and mutations, performs a binary search at each node. In interior nodes, this tells you which child may contain your target, and thus where to descend. In leaf nodes, it tells you if the target exists or not.

> Note: unlike most implementations of B/B+ trees, interior nodes in this library store the **max** recursive key rather than the min for esoteric reasons.

Implementation of most operations is wildly simple:
- Inserts greedily split "full" nodes (those with size equal to the branching factor) on the way down during search.
- Search queries, including range queries, are some simple combination of a downward search and optionally sideways iteration.

The only (slight) exception to this is removals, which must redistribute keys--and potentially merge underfilled nodes--among siblings to maintain balance.

To illustrate, consider the following tree, which has three levels and a branching factor of four. The root has
two children (half full), each other internal node has four children (full, will split on the next insertion that navigates through them), and every leaf has four keys at the same depth:

> Tip: the B+ tree diagrams in this article are interactive, and powered by **the actual sorted-btree library**! Clicking on different nodes allows you to insert/remove from the tree based on that node's key range to see how the structure changes.

:::btree recap #recap-tree
:::

The specific implementation of a B+ tree that I co-authored is highly optimized (seriously, there were at one point unrolled loops) and offers all of the standard functionality as well as a set of more advanced features, including...

### Cloning in constant time {#cheap-cloning}

The B+ tree library supports O(1) cloning of entire trees, allowing developers to do something like:

`const treeA = makeSmallTree(...); // treeA contains keys 1, 2, 3, 4`

`const treeB = treeA.clone(); // treeB also contains keys 1, 2, 3, 4`

`treeA.delete(2); // treeB now contains keys 1, 3, 4, but treeB still contains all four keys`

How can this be done in constant time? The key to this is to share nodes by reference, performing clones lazily when mutations would impact them. In other words, a call to `clone` does the following:

- Creates a new B+ tree wrapper object and assigns a pointer to the cloned tree's root node to its own root field.
- **Marks that root node as shared** by setting an `isShared` flag to true.

By setting `isShared`, any mutation code can detect shared nodes and perform a shallow clone on them before any mutation occurs; without this, all trees that contain references to the node would appear to have been mutated. To avoid this, during the recursive descent in mutation methods, each node with `isShared === true` is copied shallowly before moving down into its children.

This scheme, often referred to as **copy-on-write**, is depicted in the diagram below. The nodes are colored according to the tree that they originated in, as shown in Tree2 (the clone) having an identical interior to Tree1. Try mutating Tree2 to see how copy-on-write works!

:::btree sharing #sharing-tree
:::

## Set operations in sublinear time {#set-ops}

B-trees are generalized collections that offer log-time queries and mutations, making them a competitive choice when a map interface is called for, particularly when the spikes from hashtable amortization aren't tolerable. Combine this with constant-time cloning and range queries, and you have a data structure that is particularly suitable for representing [sets](https://en.wikipedia.org/wiki/Set_theory). It is frequently necessary, then, to compute algebraic operations (union, intersection, symmetric difference, etc.) over these sets. On the Fluid Framework team, we use them so heavily in this way that several scenarios became bottlenecked on the runtime of the naive implementations of these operations!

### Making is slow {#slow}

Consider the *union* operation. The semantics are simple: for two sets, `A` and `B`, `A union B` (or `A∪B`) contains all keys from `A` and `B` combined. The straightforward implementation, given two B+ trees, would be to iterate both `A` and `B`, adding all key/value pairs from both into a new B+ tree `C`; collisions (where the same key is present in both `A` and `B`) can be resolved in whatever fashion is preferred, often by nominating one tree as the tiebreaker. Similarly, intersection would be computed by adding to `C` only keys that are present in *both* `A` and `B`. These algorithms are clearly *O(S<sub>AB</sub> * log(S<sub>AB</sub>))*, where *S<sub>AB</sub> = size(`A`) + size(`B`)*.

Can we do better? Well, if you are implementing the algorithms *on top of* the B+ tree interface, then...you *kind of* can. Naively, it would seem that adding all the keys from `A` and `B` into `C` would necessarily require looking at *all of the keys from `A` and `B`*. But we aren't using just any B+ tree library--we have the ability to clone an entire collection of keys **in constant time**!

> Note: this analysis is primarily concerned with time overhead; space, however, has fairly similar bounds across these examples.

Okay, so now we do the following:
- Clone the larger of the two trees.
- Iterate all entries in the smaller, and add them to `C`, tiebreaking as necessary.

This gives us *O(M * log(M))*, where *M = min(size(`A`), size(`B`))*, which is certainly better!

At this point, we have exhausted the speedups we can get while working outside of the B+ tree library. Unfortunately, this approach is also still slow enough that my team remained bottlenecked. After a lot of deep research queries and poking through literature, I was disappointed to discover that no algorithm for set operations with a sublinear bound existed in any self-balancing trees--at least that Claude and I could find. Determined to find one, I managed to find a couple of free evenings and derived a solution that is both relatively simple and (I believe) optimal! These solutions are [implemented and published](https://github.com/qwertie/btree-typescript/tree/master/extended) in the sorted-btree library.

### Making it fast: decomposition {#fast-decomposition}

Consider two trees, each with contiguous key ranges:

```text centered
A:   0 ................................ 50
B:                           45 ............................... 100
Overlap:                       |45...50|
```

Tree `A` holds `0..50`; tree `B` holds `45..100`. Critically, their only overlap is the single interval `45..50`. A fast union or intersection should surely be able to exploit this. The key once again lies in the ability to share subtrees via the copy-on-write scheme. In this example, we can imagine a solution that cheap-clones the subtree in `A` containing `0..44` into `C`, then adds to it all keys that intersect (`45..50`), and then adds a cheap-clone of the subtree in `B` containing `51..100`.
This feels like it's on the right track: the clones cost O(1) per subtree, and the remaining time is spent iterating over the colliding keys, so intuitively this feels bounded in a way that is related to the intersection.

> One of the nice side-effects of a B+ tree's range query support is O(R) processing time for ranges of size R: once the starting point is found, walking "horizontally" across the tree avoids repeated log(N) walks. It's easy to convince yourself that this is O(R) when you consider that the total number of nodes in a balanced tree with branching factor > 2 is always less than 2N. BTrees have much higher branching factors, so this is extremely efficient.

Revisiting the example, consider how we would perform a union (a merge!) if these were sorted lists of numbers:
- Initialize a new list `C` to add the union into.
- Initialize two pointers/cursors, each pointing to the beginning of one of the two input lists.
- In a loop, compare the cursors
    - If one of them is pointing to a lesser key (it is considered "behind" the other), move it forward, adding the entry to `C` at the same time.
    - If they are pointing to keys that compare equal, merge their values via the `combineFn` passed into the function, add that new entry to `C`, and **move both pointers forward**.

Notice that this is the standard merge algorithm performed in various other algorithms (the most iconic being mergesort). It will first iterate over the leading segment of `A`, meaning the contiguous range from `0..44` that has no intersection with any key in `B`, then iterate over the intersection, and finally it will process the trailing segment in `B`. In the case of lists, processing all three segments is linear in the length of the segment, giving a total runtime that is O(A + B). In a **standard** B+ tree analogue, the same logic applies: initialize a cursor in both trees, walk them forward in the same pattern, and add all entries into a new tree. The runtime would be identical, as *all entries must be visited* in order to add them to the new tree.

> In this context, a **cursor** is simply a stateful pointer into a tree. In the B+ library, this is implemented as a mutable stack of nodes that can be "walked" to various locations in the tree via navigation methods such as `moveTo`, which moves a cursor forward until it points to a key that is >= some target.

Luckily for us, in our B+ tree, the copy-on-write scheme means **we don't have to visit all entries to copy them!** We can clone entire subtrees instantly and use them in the new tree without ever descending into them. Instead of a mergesort-style walk, we decompose both trees into non-overlapping subtrees that we clone and, along with any intersecting entries, build them up into the union result. 

> This section ignores exactly **how** to take a decomposed set of subtrees and entries and turn them into a valid, balanced B+ tree. This is revisited in the [reconstruction section](#fast-reconstruction).

The trivial range example we've been using so far hides a few small challenges that a generalized solution must handle. Most obviously, there is only a single overlap segment. A more realistic example could look something like this:

```text centered
A:   0..........10          20..........30          40..........50
B:         5..........15          25..........35           45.........55
Overlap:  |5....10|              |25....30|               |45...50|
```

When reasoning at the segment abstraction, this just means that instead of `leading<sub>A</sub>, intersection, trailing<sub>B</sub>` we instead must process the more general `leading<sub>A | B</sub>?, [intersection, trailing<sub>A | B</sub>?]*`. This alone does not change the algorithm meaningfully, but observe that we can construct arbitrary inputs such that the *B+ tree representations* of these ranges overlap in ways that do not map to clean cuts through the tree. This is illustrated in the following diagram, which highlights the leaf nodes to show how the "segments" of key space (or the runs of keys in between intersecting segments) are orthogonal to node boundaries.

> This diagram depicts two B+ trees containing the key ranges from our first example, as well as the tree that results from the union of those two trees. As before, interior nodes are given a color based on which tree they were originally from, allowing us to observe which subtrees can be reused as part of the result tree. The red underlining in the input trees denotes segments of contiguous ranges of key space as they are walked in sort-order. Those same segments are shown again in the output tree, highlighting which input trees contributed which ranges in the output. We are skipping over large parts of the algorithm, including both the decomposition into reusable subtrees and the reconstruction, which will be covered later.

:::btree small-overlap #tree-small-overlap
:::

Observe how the span of these segments across the bottom of the tree may be related to which subtrees are reused in the final output tree. Any subtrees whose **leaves are fully enclosed by a segment** are eligible for reuse. This is obvious when stated in terms of key space: segments are contiguous ranges of key space, defined by start and end points, for which there are *no keys in the entirety of the other range that are found between the start and end points*. Now notice that B+ tree nodes themselves define key space ranges! It makes sense, then, that when a subtree's leaves are entirely enclosed by the red segment highlighting, it implies that there are no keys in the other input tree that are found between the start and end keys of that subtree. In a tree with branching factor of four, this means that any leaf with all four of its keys enclosed by a segment is eligible for reuse, as is its parent if all four of *its* child leaves are enclosed, and so on.

You can clearly see this illustrated in the previous diagram. Red segment #1 spans 45 contiguous keys (0-44) in tree `Tree1` which are contained in 12 leaf nodes. This segment encloses 11 of those 12, which means it fully encloses three interior nodes (those denoted by first/last keys of 3/15, 19/27, and 31/39). The last leaf, which contains keys 44-47, is only partially enclosed by segment #1, which stops after the first key in that leaf and is, by definition of a segment, followed by a key in `Tree2` (in this case, it is an intersecting key and thus appears in *both* trees, but it ends the segment all the same).

> You may have noticed that the final interior node enclosed by segment #1 (node 31/39) does not actually end up in the final tree. This is not due to a failure to reuse the node, and is instead a side-effect of the reconstruction process, which does attempt to reuse it. However, during reconstruction, the entries and reused subtrees from `Tree2` are combined into `Tree3` in such a way that induces a split of that node. This causes it to be shallow-cloned (as we must do in a copy-on-write scheme to avoid mutating `Tree1`!) and eventually split into two interior nodes, each of which points directly to reused leaf nodes.

Now let's see how the second example translates into B+ trees, and how having an overlap-dense key space affects the amount of reuse that is possible.

:::btree large-overlap #tree-large-overlap
:::

Dense clusters of overlaps translate directly into short segment lengths, which themselves cannot possibly span large runs of leaves, so we get essentially no reuse! It gets worse: consider two trees in which all keys in one are odd, and all in the other are even.

:::btree alternating-overlap #tree-alternating-overlap
:::

*Zero reuse!* It turns out that what we'd wanted (time complexity that scales in relation to the size of the intersection) is not possible. The size of the intersection in this example is zero, but the unit of reuse is a B+ tree node, so we can't do better than a full enumeration. Luckily, we can still avoid (only) having a linear bound. Before deriving a concrete bound, it is helpful to examine at a high level how the decomposition algorithm is operationalized.

It turns out the implementation is very similar to the cursor-based merge of sorted lists:
- Initialize an empty list `C` that will hold the decomposed contents of the input trees (both reusable subtrees and raw key/value entries) that will later be used to reconstruct the output union tree.
- Initialize two cursors, each pointing to the beginning of one of the two input trees.
    - Here, a cursor is a path from the root node to a location in a leaf.
- In a loop, compare the cursors
    - If one of them is pointing to a lesser key (call it `behind`), move it forward to point to the next key that is >= to the cursor (call it `ahead`).
        - This forward step itself *is what defines a segment.* This must be true, because `behind` started at a position before `ahead` and any keys it moves past while seeking one that is >= to `ahead` must be strictly < the key pointed to by `ahead`. Clearly, then, all keys between `behind`'s starting position and its stepped position form a totally ordered, non-overlapping run...which is the definition of a segment! Thus, **any nodes that are fully enclosed by this run are eligible for reuse** and are added to `C`.
            - Any leaves that are *not* fully enclosed by the segment are "exploded" and their entries added to `C`.
        - A critical implementation detail to note is that stepping a cursor forward in this manner *is not a linear enumeration* and can instead be done in `O(log<sub>B</sub>(S))` time, where `B` is the branching factor of the B+ tree and `S` is the length of the segment. This is achieved by walking the cursor up the tree until it points to a node that contains its destination key (something that can be determined without descending in the same way as a standard B-tree search), then descending it directly down to its destination in an identical fashion. This up-down walk forms a triangle where the bottom (flat) leg of the triangle runs the length of the segment along the leaves, and as the walk is conducted subtrees can be `O(1)` cloned for reuse. 
    - If they are pointing to keys that compare equal, merge their values via the `combineFn` passed into the function, add that new entry to `C`, and **move both cursors forward**.

> This description omits a number of small details, such as what happens when a cursor reaches the edge of a tree before reaching a target key. These are largely unimportant and do not affect the overall analysis, but can be found in [the source](https://github.com/qwertie/btree-typescript/blob/659f2a6313a2dad080c4fa7f9c8050705b296d68/extended/decompose.ts).

Let's look at another example, this time showing the alternating up-down cursor walk. Use the timeline to navigate the cursors and observe how the steps map to segments and subtrees (reused and new) in the decomposition list.

:::btree step-timeline #tree-step-timeline
:::

We are now ready to formalize the bounds: Let `S` be the number of segments in the totally ordered list of combined keys in trees `A` and `B` and `H` be the maximum height between the two. The runtime, then, of decomposing the two trees into components for reconstruction is `O(min(S*H, A + B))`. The `A + B` term exists because this algorithm gracefully regresses to a linear enumeration in the case where reuse is impossible, as we saw in an earlier example. When reuse *is* possible, it does so in log-cost cursor steps for each of the `S` segments. The `min` operator is there to express that this algorithm runs in whichever path is optimal, which is true. The only thing left is to show that reconstruction can be done in the same time or better.

### Making it fast: reconstruction {#fast-reconstruction}

Reconstruction is the largely mechanical task of taking the decomposition list, which consists of reused subtrees as well as leaves generated from intersecting entries, and building them up into a well-formed B+ tree. In order to ensure the algorithm's overall runtime does not grow, we must not exceed decomposition's `O(min(S*H, A + B))` bound. Any solution must have the log-linear runtime when optimal, and gracefully degrade to a full enumeration when it isn't.

A reasonable first pass at this might look something like this:
- Initialize a `current` tree to the **tallest** element in the decomposition list. This is done so that we never have to handle inserting a taller tree into a shorter one (there are many other reasonable ways to structure this!).
- For each element (call it `addition`) to the **right** of it in the decomposition list,
    - If `addition` is equal in height to `current`, make a new root with both as its children.
    - Else, walk from the root of `current` along the rightmost edge of the tree (call this path from root to leaf the **right frontier**) down to the level at which the new subtree should be inserted, meaning a level with height one greater than it. While walking down, shallow clone nodes if `isShared === true`, and split nodes if they are full.
    - Insert `addition` into the node at the destination level, which is guaranteed to have room for it due to the previous step.
- For each element to the **left** of the starting element, do the same as above using `current`, but along the **left frontier**

> As a simplifying implementation detail, the decomposition walk compacts exploded entries into new leaf nodes as it goes. This compaction is done as part of a flush every time a run of these entries is interrupted by a reused subtree, and it attempts to evenly distribute the entries into new leaf nodes. If there are greater than B/2 - 1 pairs to flush, these leaves (or leaf) are guaranteed to be valid; if not, it will be a single underfilled node. Reconstruction must be tolerant to this and ensure this does not result in a malformed B+ tree. Doing so is simple and is omitted here for brevity.

Is this runtime satisfactory? Let's consider each of the two bounds separately. The `S*H` bound is optimal (i.e. `S*H < A + B`) when there are fewer segments, which corresponds to a decomposition list filled with reused subtrees. The tallest of these trees, which we use to initialize `current`, may have up to height `H`. Even if the tallest tree is shorter, one can construct arbitrary inputs such that `current` would quickly grow to be `H` in height. Thus, any given insertion may need to walk the full frontier, meaning processing each element takes `H` time. To determine if this is acceptable, we need to understand the size of the decomposition list.

It's tempting to assume the list grows proportionately to `S`. After all, we append to it during `S` cursor steps during decomposition. But it turns out that each of those steps creates "cuts" through the tree that result in logarithmic numbers of nodes added to the list! These cut lines are jagged paths through the tree that are defined by the cursor's start and end points during the step. One cut runs from the start point to the highest node the cursor must walk through before descending, and the second cut runs from that high point to the destination. This is clearly illustrated in the case where one of the input trees in a union has a single key that splits the key space of the other such that `S` is exactly 3. In the following example, that singular key is selected such that the resulting segments do not evenly enclose one giant subtree, and instead form a stair-step pattern that encloses decreasingly small nodes until it reaches a leaf that is split.

> This diagram starts out at the first cursor step (time T1). Observe the zig-zag cut the cursor path makes on its way down from the root to the leaf containing key 122. If you navigate forward to time T4, you can see a similar zig-zag that defines the cut on the way back up (and corresponding entries in the decomposition list).

:::btree slice #tree-slice
:::

We could trivially vary that single input key in the second key to cause the segments to resize arbitrarily, causing cuts that range from enclosing a single subtree to the stair-step pattern. This clearly generalizes, so with `S` segments we actually get `O(S*H)` entries in the decomposition list, since the height of that staircase is (at maximum) the height of the tree. This means that our proposed reconstruction algorithm **would have a runtime of `O(S*H<sup>2</sup>)`**. Even worse, when there is maximal intersection (and thus the `A + B` is optimal) our runtime will be `O(H*(A + B))`!

Luckily, we can make an isolated adjustment to our algorithm to avoid this extra `H` term. Where previously we would walk down the frontier every time we compose an element, we instead maintain an array of frontier nodes that enables constant-time lookup by height. This frontier array *semantically* contains all of the nodes from root to leaf, but as an implementation detail is lazily updated to avoid the same `O(H)` cost. All updates to the tree during the reconstruction process are buffered in this array and are only propagated when necessary. As a side effect of starting directly at the correct height, the algorithm must handle splitting *upwards* when necessary, rather than eagerly on a downwards traversal. During this process, which may result in cascading split-and-carry calls, any buffered information (which in this library includes cached sizes) percolates upwards. Care must also be taken to clone any nodes that are marked `isShared` to preserve copy-on-write semantics; this can be done by tracking the frontier index of the shallowest node (if any) that is marked as shared, and lazily cloning from that depth down to the target depth at which a decomposition element needs to be inserted. 

With these adjustments made, processing a series of decomposition elements with heights `H<sub>1</sub>, H<sub>2</sub>, ..., H<sub>N</sub>` costs `O(|H<sub>1</sub> - H<sub>2</sub>| + |H<sub>2</sub> - H<sub>3</sub>| + ... + |H<sub>n-1</sub> - H<sub>n</sub>|)`, because composing an element forces propagation (either upwards or downwards) from the previous height to the current. As discussed previously, the decomposition list is made up of `S` subsequences that each correspond to a segment. These subsequences are formed via cuts made by a cursor as it ascends or descends, and are thus at most `H` in length. Observe that in *all* cases, the sum of the differences in heights of these subsequences will equal the height of the tallest member subtree. Thus, since that is at most `H`, processing a full subsequence also costs `O(H)`. Multiply this by the number of subsequences (or segments) and we get the desired bound of `O(S*H)`. When there is maximal intersection, then `S = A + B` and each element in the decomposition list will be a leaf; this means `O(S*H)` is equivalent to `O((A + B)*H)`, and `H<sub>leaf</sub> = 1`, so we also get our alternative bound of `O(A + B)`!

> This math ignores upwards splitting. While this splitting can cascade all the way and does indeed add an additional `H` in cost in those cases, this splitting is amortized `O(1)` in cost due to such cascades growing exponentially less likely.

This final reconstruction algorithm is shown below with both minimal and maximal overlapping.

:::btree reconstruction-min #tree-reconstruction-min
:::

:::btree reconstruction-max #tree-reconstruction-max
:::

### What about the others? {#the-others}

Decomposition, reconstruction, and cursor walks turn out to be generally useful operations. These same primitives are used in the library to implement other common set operations:
- **Subtract**: the same algorithm as union, but intersecting entries are dropped and only the left-hand operand's cursor ever adds to the decomposition list
- **Symmetric difference**: identical to union, but intersecting entries are discarded
- **Intersect**: same cursor walk, but no attempts at reuse are made as disjoint entries are by definition not in the intersection

The final diagram below allows you to try out these operations. You can also add new trees, populate them with entries, clone trees, and more! Click on the trees to combine them, then click on the operation edges to explore how the results are computed.

:::btree playground #tree-playground
:::
