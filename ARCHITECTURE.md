# Architecture

## 1. Ownership and data model

One named agent maps to one SQLite-backed Durable Object. `Lifecycle.install()` composes the official PiHarness and a separate memory-work capability. Pi owns exact transcript entries, inbox admissions, model and tool tasks, retry decisions, provider session identity and crash recovery. Memory tables use `hm_`, never `pi_`; Agents lifecycle tables are also managed only by that SDK.

| Table | Ownership/role |
| --- | --- |
| `hm_events` | Immutable L2 raw records: id, global sequence, namespace-local position, kind, content, metadata, creation time and SHA-256 content hash |
| `hm_nodes` | Immutable L0/L1 summaries: namespace-local range, level, algorithm version, content hash, direct children and all source event ids |
| `hm_embeddings` | Rebuildable exact-vector index keyed by entity id, model and embedding version |
| `hm_fts` | Rebuildable SQLite FTS5 index over event content and summary representations |
| `hm_submissions` | Frozen retrieved context and submitted text blocks, keyed by Pi operation id |
| `hm_epochs` | Advisory log of explicit host reset/handoff boundaries |

SQLite triggers reject updates and deletes of events and summary nodes. A raw event's embedding status is **derived** from the leaf node and model/version index; it is not a mutable field on the immutable raw row. Missing nodes/index rows are durable work state. An independent memory engine can run against the Node SQLite adapter with no Cloudflare runtime or HTTP layer.

Event payload hashes cover content, kind, namespace and canonical JSON metadata. Caller idempotency keys derive event ids; same key/different payload fails. Anonymous writes get UUID ids, permitting repeated observations. Events and their FTS entry commit in one synchronous transaction. Node and FTS inserts also commit atomically. Memory uses Durable Object `transactionSync` only for synchronous SQL; network awaits never run inside it.

## 2. Incremental immutable binary trees

Every namespace has its own zero-based sequence of positions. Level 0 summarizes one event; level 1 covers two events; level 2 covers four; level `k` covers `2^k`. Only aligned, completed ranges are eligible:

```text
0 ─┐             4 ─┐
   0–1 ─┐           4–5 ─┐
1 ─┘    │        5 ─┘    │
        0–3 ─┐           4–7 ─┐
2 ─┐    │    │   6 ─┐    │    │
   2–3 ─┘    │      6–7 ─┘    │
3 ─┘         └──── 0–7 ───────┘
```

Appending position 8 creates its leaf; appending 9 permits 8–9; 10 and 11 permit 10–11 and 8–11. No 0–7 summary is rewritten. A parent consumes its children's L1 summaries, not every historical event. A node hash covers algorithm version, namespace/range/level, summary content and child hashes; its id is content-addressed. A unique namespace/range/version constraint guarantees one persisted summary for that range in that version.

Changing summarizers builds a new tree version beside the old one. Search uses the active summarizer version; historical nodes remain readable by id. Cloudflare summarizer versions include model id and prompt revision. For a model whose weights can change behind an alias, applications should provide an explicit revision in their summarizer version.

For `N` events, a complete tree has fewer than `2N` nodes. This v1 scans ranges to discover missing work; it performs new model work only for missing ranges. Model work is incremental, but scheduler bookkeeping currently scans the corpus. Direct child ids support progressive traversal; full event-id lists make provenance and overlap detection simple but cost `O(N log N)` total metadata. A future range-based provenance implementation should reduce this overhead.

## 3. L0, L1 and L2

- L0: short abstract, typically 20–60 tokens, returned by search.
- L1: decision-oriented summary, typically 100–400 tokens, loaded by `read(nodeId)`.
- L2: original event, always retained and returned by `read(eventId)` or leaf expansion.

`expand(nodeId)` returns direct children. Parent -> child summaries -> leaves -> raw event is explicit and inspectable. A search hit for a leaf uses the event id and leaf abstract; read then returns raw detail directly. Higher nodes return their own ids. Callers can stop at any level.

Workers AI summaries use a strict JSON schema requiring string L0/L1 fields, then validate nonempty strings and size bounds. The adapter handles both legacy `response` and newer OpenAI-compatible `choices` outputs. For the default GLM model it disables thinking with the supported chat-template setting so reasoning cannot consume the summary output budget. They preserve decisions, outcomes, preferences, entities, unresolved issues, failures and causality, and treat source text as untrusted data. Bounds are approximate model instructions rather than exact generated-token constraints. The offline extractive fallback truncates summaries and can omit detail; raw FTS/L2 remain accessible.

## 4. Hybrid retrieval

The deployed engine embeds query text with Workers AI and performs exact cosine scoring against stored active-version summary vectors. SQLite FTS5 uses `unicode61` tokenization and BM25 over immutable source content plus summary representations. Search phrases are assembled from quoted letter/number terms with a term-count bound, never raw user FTS syntax. Search returns only L0 abstracts. FTS may locate a source through L2 text, but it does not send full L2 content to the model at discovery time.

Default score:

```text
0.6 * max(0, cosine(query, summary_embedding))
+ 0.3 * normalized_bm25
+ 0.1 * exp(-age / 30 days)
```

BM25 relevance is divided by the maximum positive relevance in that query's hits; cosine is clamped to [0,1]. Parent recency uses its newest source's timestamp, not its summary-generation time. Semantic and lexical signals are independently visible. Include-recent admits unmatched records too. Weights and the scoring function are injectable. Namespace filters are exact. A summary is eligible for kind filtering only when **all** its descendants pass; otherwise eligible individual sources remain discoverable. This prevents a parent from leaking filtered-out content.

Search scans eligible events and active nodes, uses existing vectors, and never triggers summary generation. Newly appended sources are lexical-searchable immediately, before L0/index jobs finish; their provisional abstract is a short raw excerpt. A semantic provider failure is surfaced as an error, rather than silently pretending semantic retrieval worked. The independent engine without an embedding provider is explicitly lexical-only.

## 5. Context budgeting and overlap

`context()` ranks candidates first, then tries bounded representations: small raw events, L1, then L0. A parent is emitted only once; if any of its source ids overlap previously selected evidence, it is skipped. A selected parent prevents its children from being repeated. This is a simple greedy policy, not an optimal knapsack or a learned reranker. It can sacrifice specific leaf detail when a broad parent wins; callers can inspect/expand manually.

The budget covers **the complete rendered memory block**, including provenance ids, JSON escaping, separators, untrusted-data notice and wrappers. It never truncates JSON or provenance to squeeze an item in. A budget too small for any representation returns an empty block. Every item carries source ids, a content hash, score components and summary version.

A pluggable `TokenCounter` defines the budget exactly. The default counts UTF-8 bytes, a conservative upper bound for byte-based BPE text tokenization that trades capacity for safety. It is not an exact tokenizer for every possible provider and excludes provider chat framing outside the memory block. Applications requiring exact provider allocation should supply their actual model tokenizer and reserve message/tool framing separately. Tests assert full rendered-byte budget, Unicode/escaping overhead, and disjoint source coverage.

## 6. Cache epochs and prompt construction

Within an epoch, stable system instructions and tool declarations are independent of all memory data. `remember()` only writes memory SQL and schedules work. It does not write to Pi, regenerate system sections, reset the session or compact the active context. Ordinary Pi transcript growth remains append-only.

Automatic retrieval is prepared at admission, not recomputed on each model request. `prepareTurn()`:

1. Finds an existing frozen operation and validates the prompt if this is a retry.
2. Searches and builds a budgeted context.
3. Atomically stores context and public Pi `UserInput` text blocks in `hm_submissions`.
4. Host submits those exact blocks to Pi with that operation id.

The blocks are retrieved evidence first, actual user text last. Pi retains the blocks as one `pi.user` entry. Future requests retain previous retrieval in exactly its original position. This is a narrow durable bridge: a crash between snapshot storage and Pi admission is recovered by retrying the operation id. There is no cross-component transaction, and the host does not independently submit snapshots abandoned by the caller. Once Pi accepts, its own inbox and recovery own completion.

**Rejected:** dynamic full-store system prompt rendering, chronological tree wake text as a system section, and ephemeral beforeRequest retrieval that disappears on subsequent requests. All can invalidate historical prefix locality.

The invariant tests observe model-facing message arrays in the official Pi runtime, before/after an external memory write and after a memory tool round. They assert that the earlier messages are an unchanged prefix of subsequent requests. Provider-specific serialization and actual cache-hit rates require live evaluation; stable transcript bytes alone do not promise a cache hit.

A reset/compaction intentionally starts a new cache epoch. Pi's persisted provider session identity can survive that boundary; a cache epoch describes prompt shape, not a provider session-id rotation. The debug endpoint includes an ephemeral `bootId` to distinguish object incarnations during deployment/restart checks. `hm_epochs` logs explicit host resets; Pi's own compaction markers remain authoritative for automatic compaction history.

## 7. Current Pi beta integration

Inspected official sources on 2026-10-04:

- [Cloudflare PiHarness documentation](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md)
- [Official PiHarness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi)
- [Pi Durable README](https://github.com/earendil-works/pi/tree/main/packages/durable)
- Installed declaration/runtime files from Agents 0.26.0 and Pi Durable/Pi AI 1.0.2.

The extension installs a constant system section and public `remember`, `recall`, `memory_expand` tools. Remember replay is safe because the event id derives from the calling Pi conversation/call id. Recall and expand are read-only and replay-safe; their results can change on a replay if more memories were appended in the meantime. The committed Pi tool result then fixes what the conversation saw.

`GenerationTask.beforeRequest` exists and can replace a request's messages, but replacement is request-only. No public persistent dedicated tail-memory channel is necessary: the host uses text blocks in the supported UserInput. **Compromise:** retrieval becomes part of the exact submitted user turn and stays in the active transcript, rather than being tagged as a separate dedicated memory entry. This costs transcript tokens but preserves cache locality. Caller/UI displays must distinguish original user text from the enriched Pi turn; the demo returns both retrieval and Pi entries separately.

Automatic compaction's public `CompactionTask.beforeCompact` hook stores selected transcript entries as lossless episode chunks and finishes summary/index work before allowing Pi's own summary and placement. Chunks have stable keys and retain offsets/total length so a source JSON document split across chunks can be reconstructed. They are archival episodes, not an assertion that every utterance is a durable fact. A model-based fact/decision extraction policy is future work.

Explicit reset refuses a busy session, retains its transcript, finishes memory work, builds a handoff and calls public session reset. There is no direct manipulation of Pi-owned SQL or undocumented transcript mutation.

## 8. Durable Object persistence and recovery

The object uses a SQLite namespace created by `new_sqlite_classes`. PiHarness opens its own durable storage and installs one SDK lifecycle job for each session with work. After eviction, that job wakes the object and Pi resumes its stored task state. Replay-safe tools can rerun; unsafe tools follow Pi's interrupted-result policy.

MemoryJobs is an independent lifecycle capability with a stable, singleflight summary job. Missing summary and model/version vector rows determine pending work after a restart. On startup it re-establishes the wake when work exists. Each alarm handles at most eight model-work units; errors log a marker and reschedule after 60 seconds without discarding sources. A same-id job pushed during dispatch preserves the newer durable intent. Explicit `compact()` finishes work even if a bounded background batch was already running.

There is a small event-commit/queue-enqueue boundary. Request acknowledgment occurs only after queue enqueue; if the process fails earlier, an idempotent caller retries and startup discovers missing work. A dormant object with neither a previously scheduled alarm nor further traffic is not promised an immediate wake for an unacknowledged write.

File-backed tests run Pi and memory tables in the same SQLite file through separate connections. They reopen both and compare exact transcripts and memories. `npm run test:recovery` runs the real Worker/SQLite Durable Object/PiHarness under Wrangler, stops workerd, restarts it using the same persisted directory and verifies unchanged events, nodes and Pi transcript. The local model is explicitly scripted. `npm run test:remote-recovery` additionally redeploys the real Worker, observes a changed object `bootId`, and asserts unchanged events, summary nodes, Pi transcript and epochs. Hosted smoke tests validate real Workers AI summaries/embeddings, Pi answers, and reset/handoff retrieval. Mid-flight eviction and alarm recovery during active real inference remain a production validation task.

## 9. Embedding strategy and Vectorize decision

Cloudflare-native choice: Workers AI `@cf/baai/bge-base-en-v1.5` (768-dimensional text embeddings). Model id and embedding interface version are stored beside every vector. The engine depends only on `EmbeddingProvider`, so another provider or revision can reindex preserved summaries/events without altering raw data. Vectors embed L0 + L1; FTS indexes raw text to compensate for summary omissions. Raw-detail vector indexes can be added later if evaluation justifies the cost.

Vectors live in the same Durable Object SQLite source of truth. Exact cosine is simple, inspectable, avoids networked index consistency problems, and needs no extra infrastructure for a small agent corpus. Workers AI is a generation service, not the memory store. Provider version changes add parallel index rows. Old vectors are retained; production should define explicit cleanup for rebuildable indexes.

[Vectorize](https://developers.cloudflare.com/vectorize/) is useful for approximate nearest-neighbor search, high volume, larger corpora and cross-object retrieval. This v1 does not use it because per-agent exact scans are adequate initially and a separately provisioned index would add asynchronous writes, deletes and consistency management. If adopted, Vectorize should be an acceleration layer populated from SQL, with SQL ids/content/provenance authoritative. Search currently scales linearly with nodes/vectors and loads all records; it is not intended for a million-event agent.

## 10. Security, alternatives and future work

All data endpoints require a Wrangler-managed shared demo secret; without it they fail closed. Requests are capped at 150 KB, raw events at 100,000 characters, user prompts at 10,000 characters, and search limits at 1,000. Bindings provide Workers AI authentication. `.env*`, `.dev.vars*`, `.wrangler/` and local databases are ignored. Logs print markers, not raw errors/provider output/memory. Retrieved text is JSON-encoded inside an explicit untrusted-data wrapper; it must never be treated as policy. Prompt wording does not guarantee immunity to prompt injection.

Rejected for v1: a graph database, cross-agent memory sharing, provider-locked core algorithms, an external vector infrastructure dependency, destructive summarization/deletion, and polished consumer UI. A developer inspection page plus scored JSON responses favors auditability.

Production work:

- Per-user identity/authorization, rate limits, tenant isolation and spend caps; one demo token is not sufficient.
- Pagination, index limits, fair scheduling under sustained writes, exponential retry/dead-letter visibility and operator controls.
- Exact model tokenizers; summary/retrieval quality datasets, contradiction handling, and important-leaf selection versus broad summaries.
- More efficient range discovery/provenance and optional ANN indexing when measurements justify it.
- Durable export, backup, migration/version policy, retention and explicit privacy/deletion workflows.
- Durable extraction of individual decisions/preferences at compaction, beyond retaining lossless episodes.
- Streaming/status APIs, controlled admission during resets, and multi-session host routing.
- Hosted eviction during live inference/tool execution, provider failure tests and measured cache-hit rates.
- SDK beta upgrade checks and source/attribution reviews for future imported code. This repository implements its own algorithms and does not copy OptMem/OpenViking source.

## 11. Remote T3 chat bridge

The application now supplies authenticated admission (`/submit`), query/control (`/rpc`), and operation-scoped SSE (`/events`) around public PiHarness session methods. Pi remains the scheduler and durable transcript owner. Frozen retrieval is submitted through the same `prepareTurn()` as HTTP chat, so streaming does not alter the cache invariant.

A local JSONL executable projects Pi Durable events into the subset of coding-agent RPC T3 consumes. Local private manifests map T3 session references to isolated DO names and persist an in-flight operation id before network admission. Reconnection snapshots/final entries supply only missing suffixes; divergent already-emitted text fails rather than silently duplicating or replacing it. Stream disconnect cancels the observer, not Pi execution. `abort` explicitly stops Pi work.

This is intentionally a documented compatibility adapter, not native Pi CLI session-file compatibility or a remote coding workspace. T3's injected local extension cannot run in a Cloudflare Worker. Richer workspace execution and accurate frontend capabilities require a separate provider/tool design. See [T3-BRIDGE.md](docs/T3-BRIDGE.md) for the full mapping, tested recovery boundaries and unsupported commands.

Workers AI's public binding is wrapped for Pi requests that ask for `returnRawResponse`: native Responses pass through, SSE ReadableStreams become Responses with event-stream headers, and JSON results become JSON Responses. The independent summarizer/embedding binding calls retain their original behavior. A test exercises the official Agents provider after a tool-result history with a JSON binding response. No dependency internals or prompt records are patched.
