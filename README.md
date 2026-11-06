# Usage Dashboard for DeepSeek Harness

**DSH 0.2.2-rc.1**, plugin **0.1.1**. A separate user-owned extension; it does not modify the application archive, OAuth plugin, model configuration, credential store or billing.

## Interface

- **Usage** in the conversation composer dock opens a compact session/last-call report. The existing native whole-log token and context widgets remain unchanged. The added badge shows cost only, to avoid duplicating the native token pill.
- **Usage** in the sidebar opens an independent page with Sessions / Models / Days, local-calendar date filters, a bounded daily-token chart and progressive history loading. **Close** at the top right returns to the Conversation through the native layout service without closing or switching the current Session.
- Reports show **own settled calls**. Copied fork/seed history is excluded; its original usage belongs to the ancestor session. Context pressure is separate, not cumulative token consumption.
- History loads five sessions at a time. Totals and graphs describe **loaded sessions**, not the entire account. Refresh restarts the snapshot; expired cursors require Refresh. Native header enumeration itself is unpaged.
- Day grouping uses the displayed IANA time zone and durable settlement timestamps, not session creation or a provider invoice date. Missing dates/usage, unavailable sessions and truncation are explicit.

## What the figures mean

Input is uncached input. Cache read/write are separate disjoint buckets; reasoning is already included in output. Missing values remain unavailable, not zero. A provider's authoritative total can prove a missing cache bucket is zero; otherwise it remains unknown.

A final usage sample replaces earlier samples for the same attempt. Retry boundaries add another attempt. A later incomplete settlement does not erase an already reported sample: the known subtotal remains, marked partial. Surface edits/compaction do not undo earlier consumption. Only recorded assistant message/attempt settlements can be accounted; unrecorded auxiliary requests or provider-side charges are not invented.

Dollar values are **API-equivalent catalog estimates, not money charged, an invoice, credit balance, subscription entitlement or remaining quota**. They use the public pi-ai **1.3.0** catalog bundled with this DSH release, exact provider/model keys and per-call tier thresholds. They do not know historical tariff changes, endpoint overrides, discounts or the profile's effective commercial terms.

Known possible subscription/token-plan routes are conservatively excluded from dollar estimates. **Subscription / not calculated** is a presentation policy, not proof that a historical request used OAuth: generic durable headers do not record its authentication kind. In particular ChatGPT/Codex tokens are not converted into a fabricated subscription charge. Unknown aliases/models, synthetic all-zero prices, missing counters and ambiguous cache-write duration remain unpriced. Partly priced totals are labelled partial.

The pinned cost-unit contract is [pi 1.3.0 model documentation](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/rpc-commands.md): US dollars per million tokens.

## Privacy and admission

The Host registers only two exact POST handlers on DSH's **existing authenticated-owner Connection carrier**. No new server/listener, permission/grant, Gateway wildcard or credential resolver is created. Native carrier admission precedes these handlers; they additionally require JSON, the non-simple `X-DSH-Usage: 1` header, bounded 4 KiB input and Origin/Host checks. Desktop's established bridge may legitimately omit Origin. Raw path-like session inputs are rejected.

History observation is local, read-only, through `sessionQuery.observeSession` with `projectionMode: 'none'`; the native implementation internally reads/validates stored logs. No cold Agent is attached or resumed. The extension selects only usage counters, recorded route IDs and event timestamps and releases each observation lease. It never returns message text, streams, headers, tools, cwd, titles, credential references, paths or raw exceptions. The credential store, environment keys and model-discovery APIs are not inspected.

Sanitized folds and opaque cursor snapshots are bounded, in-memory and profile/service-identity scoped. Cordis proxies are compared by canonical identity while calls remain through traced proxies. Session logs and projection caches are not rewritten by this extension. Native cold-log loading is not made byte-paged by our five-session cohort limit. Per-session event/call/stream limits produce explicit partial reports.

## Verification and builds

Use Node.js 22 or newer. There are no runtime or development dependencies to install.

```sh
npm run build
npm run check
npm test
npm run test:native
```

Deterministic tests cover accounting, retries/forks, unknown values, pricing/tier boundaries, profile/proxy identity, cancellation/disposal, cursor paging, time zones, UI controller lifetimes and the owner-carrier request envelope. Component/controller fixtures are **not real browser verification**.

The optional `test:native` command requires macOS and the matching installed Desktop application. CI runs only the portable build, syntax and deterministic test checks.

The native smoke uses the actual installed Cordis, SessionStore, SessionQuery, plugin fiber and Connection owner gate, with a new isolated in-memory Context and synthetic browser authentication. It starts no socket, reads no user profile/logs/credentials and makes no model or network request. Synthetic fixtures prove the integration contract, not live browser rendering or actual account billing.

The prebuilt browser artifact is generated from the owned source and self-contained arithmetic. It loads only the host's provided React, with no private client-value imports or second renderer. It requires no development watcher or replacement GUI server. A different DSH release requires contract revalidation, not a compatibility exemption.

To regenerate the factual pricing snapshot, run the generator with bundled Electron-as-Node or pass an extracted **public SDK code** root as its argument. It parses only provider catalog JSON, never imports model discovery/auth and never reads settings.

## Install / rollback

Clone into a permanent directory: the installed plugin links to this checkout. No npm install or build is needed to use the committed prebuilt browser artifact. Use the bundled CLI matching the running application, not an older globally installed `dsh` command:

```sh
git clone https://github.com/rooty/dsh-usage-dashboard.git
cd dsh-usage-dashboard
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$PWD"
```

Fully quit DSH with **⌘Q**, reopen it, then check the composer Usage badge and sidebar Usage page in the existing GUI. No logout, reauthorization, API key or provider change is needed. Until that manual check the UI is a verified-build preview, not a claim of live GUI success.

To remove the bundle selection without deleting conversations or credentials:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove @local/dsh-usage-dashboard
```

## Known limitations

- Compatibility is pinned to DSH **0.2.2-rc.1**; other releases require revalidation.
- The closed composer cost badge does not currently subscribe to settlement updates. Open Usage or click Refresh to load current values; while the popup is open, it refreshes every ten seconds.
- Builds, fixtures and native smoke tests do not establish live browser rendering or actual account billing.

## License

[MIT](LICENSE) © 2026 Vitalii Mikhnevych. The public pi-ai pricing snapshot retains its upstream MIT notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This is a third-party plugin, not an official DeepSeek or provider integration.
