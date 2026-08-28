# n8n-nodes-shopware-sync

An [n8n](https://n8n.io/) community node for the **Shopware 6 Sync API**.

Existing Shopware nodes write one record per request. This node targets
`POST /api/_action/sync`, Shopware's bulk endpoint, and adds automatic batching on
top: point a stream of items at it and it groups them by entity, splits them into
right-sized requests, and sends them. Importing 5,000 products is a two-node
workflow rather than a loop.

It is also entity-agnostic. Because the Sync API takes the entity name as data,
this node works with *any* Shopware entity — `product`, `category`, `customer`,
`product_manufacturer`, `property_group_option`, custom entities from your own
plugins — without needing an update per entity.

## Installation

**Settings → Community Nodes → Install**, then enter:

```
@scope01gmbh/n8n-nodes-shopware-sync
```

## Credentials

Create an integration in Shopware under **Settings → System → Integrations** and
copy its access key ID and secret access key.

| Field | Example |
|---|---|
| Shop URL | `https://shop.example.com` (no `/api` suffix) |
| Access Key ID | `SWIA...` |
| Secret Access Key | the integration's secret |

The node exchanges these for a bearer token via `client_credentials`. Shopware
tokens are short-lived (600s on 6.7), so the token is stored as an expirable
credential field and refreshed automatically.

Make sure the integration has write permissions for the entities you intend to
sync, or grant it administrator rights.

## Operations

### Create or Update (upsert)

Each incoming item becomes one Shopware record. Records are grouped by entity and
split into batches of **Batch Size** (default 100).

Shopware upserts on primary key, so include an `id` (32-char hex UUID) to update
an existing record, or omit it to let Shopware generate one.

```
Entity:        product_manufacturer
Action:        Create or Update
Payload Source: Input Item
Batch Size:    100
```

Use **Payload Source → Field of Input Item** when the record sits in a nested
field rather than at the top level of the item.

Use **Payload Source → JSON** to write the record yourself and map each field with
expressions, the way you would fill the JSON body of an HTTP Request node:

```json
{
  "id": "{{ $json.Internal_id }}",
  "name": "{{ $json.Manufacturer_name }}",
  "mediaId": "{{ $json.Logo[0].internalid }}"
}
```

Supply only the record. The `entity`, `action` and `payload` wrapper that the Sync
API expects is built for you from the fields above, so this node sends:

```json
[{ "key": "...", "entity": "product_manufacturer", "action": "upsert",
   "payload": [ { "id": "...", "name": "...", "mediaId": "..." } ] }]
```

**The field must be in expression mode.** n8n only evaluates `{{ ... }}` when a
parameter is switched from Fixed to Expression; in Fixed mode the placeholders are
sent to Shopware as literal text and come back as
`FRAMEWORK__WRITE_CONSTRAINT_VIOLATION ... is not a valid uuid`. The field ships in
expression mode by default, and the node refuses to send a fixed-mode payload that
still contains `{{ $... }}`.

The JSON is evaluated once per incoming item, so `$json.*` refers to that item.
Returning an array emits several records from a single item:

```json
[
  { "id": "{{ $json.a_id }}", "name": "{{ $json.a_name }}" },
  { "id": "{{ $json.b_id }}", "name": "{{ $json.b_name }}" }
]
```

Note that a `"{{ ... }}"` placeholder inside quotes always produces a string. If a
source field may be missing, the literal text `undefined` is sent and Shopware
rejects it - guard optional fields, for example
`"mediaId": "{{ $json.Logo?.[0]?.internalid || null }}"`, or drop the quotes to
send a real number, boolean or null.

### Delete

Two modes:

- **Records From Input** — each item supplies the record to delete, normally just
  `{ "id": "..." }`. Batched like upserts.
- **Filter Criteria** — delete everything matching a filter, no IDs needed. Sent
  as a single request.

```json
[
  { "type": "equals", "field": "active", "value": false }
]
```

`criteria` is only honoured for deletes; Shopware ignores it on upserts.

## Options

| Option | Effect |
|---|---|
| **Indexing Behavior** | `Index Immediately` (Shopware default), `Queue Indexing` (defer to the message queue), `Disable Indexing` (skip entirely) |
| **Skip Indexers** | Comma-separated indexers to skip |
| **Only Indexers** | Comma-separated allow-list of indexers |
| **Simplify** | On (default): one compact summary per batch. Off: the raw Shopware `SyncResult`. |

Indexing is usually the bottleneck on large imports. `Queue Indexing` is the safe
speed-up. `Disable Indexing` is fastest but leaves the shop stale until you run:

```bash
bin/console dal:refresh:index
```

## Output

With **Simplify** on, one item per batch:

```json
{
  "key": "upsert-product_manufacturer-0",
  "entity": "product_manufacturer",
  "action": "upsert",
  "records": 100,
  "success": true,
  "notFound": [],
  "deleted": []
}
```

Output items keep `pairedItem` links back to every input item in the batch, so
downstream nodes and the n8n UI can still trace a row to its source.

## Error handling

A failed batch throws a `NodeApiError` naming the operation key. Enable
**Continue On Fail** on the node to collect failures as items
(`success: false`, plus `error`) and keep processing the remaining batches.

Note that Shopware wraps each sync request in a transaction: if one record in a
batch is invalid, that whole batch is rolled back. Smaller batches therefore lose
less work on failure.

## Compatibility

Developed and tested against **Shopware 6.7**. The sync endpoint and its
`entity`/`action`/`payload`/`criteria` contract are also present in 6.4–6.6.

## Examples

Importable workflows live in [`examples/`](examples/), covering every write path:

| Workflow | Shows |
|---|---|
| [01 Create and update products](examples/01-create-and-update-products.json) | The full mandatory payload a create needs, with ids derived so re-runs update instead of duplicating |
| [02 Update existing products by id](examples/02-update-existing-products.json) | An update carries only the id and the fields that change |
| [03 Sync from a source system](examples/03-sync-from-source-system.json) | Mapping a PIM/ERP feed onto Shopware payloads, idempotently |
| [04 Delete products by id](examples/04-delete-products.json) | Removing what example 01 created |
| [05 Use the node as an AI agent tool](examples/05-ai-agent-tool.json) | The node on an agent's tool port, with `$fromAI()` parameters |

See [examples/README.md](examples/README.md) for the three shop-specific ids you
need to fill in first, and how to find them.

## Development

```bash
npm install
npm run dev     # runs n8n at http://localhost:5678 with this node linked
npm run lint
npm run build
```

The end-to-end suite runs the compiled node against a real Shopware instance. It
creates and then deletes `product_manufacturer` records prefixed
`n8n-sync-test-`, so point it at a disposable instance only:

```bash
SW_URL=http://sw67.local \
SW_CLIENT_ID=... \
SW_CLIENT_SECRET=... \
node test/e2e.mjs
```

### Testing in an existing n8n instance

Before the package is on npm, you can side-load the built node into a running
n8n. Copy `dist` into n8n's custom extensions folder (`~/.n8n/custom`, which lives
in the `n8n_data` volume for Docker installs):

```bash
npm run build
docker exec -u node n8n mkdir -p /home/node/.n8n/custom/n8n-nodes-shopware-sync
docker cp dist/. n8n:/home/node/.n8n/custom/n8n-nodes-shopware-sync/
```

The node imports `n8n-workflow` at runtime, and the custom folder has no
`node_modules` to resolve it from, so link n8n's own copy or the node fails to
load with `Cannot find module 'n8n-workflow'`:

```bash
docker exec -u node n8n ln -sfn \
  /usr/local/lib/node_modules/n8n/node_modules/n8n-workflow \
  /home/node/.n8n/custom/n8n-nodes-shopware-sync/node_modules/n8n-workflow
```

Restart n8n afterwards - custom directories are scanned once at boot.

## License

[MIT](LICENSE)
