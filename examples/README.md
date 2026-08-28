# Example workflows

Importable workflows covering every write path the node supports: creating,
updating, syncing from an upstream system, deleting, and driving the node from
an AI agent.

## Import

In the n8n UI: **Workflows → Import from File**, one file at a time. Or from the
CLI, against an instance that has the node installed:

```bash
n8n import:credentials --input=examples/credentials.example.json
n8n import:workflow --separate --input=examples/
```

## Before the first run

Every example that **creates** a product needs three ids from your own shop.
They are set as constants at the top of the workflow's Code node, and the node
throws a clear error if you leave them at their placeholder value.

| Constant | Where to find it |
|---|---|
| `TAX_ID` | Admin → Settings → Tax, or `SELECT LOWER(HEX(id)), name, tax_rate FROM tax;` |
| `SALES_CHANNEL_ID` | Admin → Sales Channels (the id is in the URL), or `SELECT LOWER(HEX(id)) FROM sales_channel;` |
| `CURRENCY_ID` | Already set to Shopware's default EUR (`Defaults::CURRENCY`). Change it only for a non-EUR shop. |

`examples/credentials.example.json` carries placeholder values — replace them
with a real integration's access key and secret (Admin → Settings → System →
Integrations) before importing, or create the credential in the UI instead.

## Workflows

**01 Create and update products** (`shopwareUpsert01`) — two products with the
full mandatory payload: `productNumber`, `name`, `stock`, `taxId` and `price`,
plus `visibilities` so they actually appear in a storefront. Ids are derived
from the product number, so the first run creates and every later run updates
the same two records. Run it twice to see the difference.

**02 Update existing products by id** (`shopwareUpdate02`) — the other half of
upsert: an update carries only the id and the fields that change, with no
mandatory payload. Uses the JSON payload template rather than the whole item.

**03 Sync products from a source system** (`shopwareSync03`) — the shape most
integrations need. An array stands in for a PIM or ERP feed; swap it for an HTTP
Request node, a database node, or the Pimcore Datahub node. Upstream SKUs are
hashed into stable Shopware ids, which is what makes the sync idempotent instead
of duplicating the catalogue on every run.

**04 Delete products by id** (`shopwareDelete04`) — removes what example 01
created, regenerating the same ids from the same product numbers.

**05 Use the node as an AI agent tool** (`shopwareAgent05`) — the node on an
agent's tool port, twice: one tool that creates and one that renames. Parameters
come from `$fromAI()`, and the product id is derived in the expression itself
with `.hash()`, so the agent never has to invent one. Add credentials to the
chat model node before running.

## Notes

Deleting **by criteria** is also supported (`Delete By` → `Criteria`) but is not
used in these examples. On shops with Shopware's commercial ProductBundles
feature installed, criteria that touch `product` are refused for integration
tokens — the `bundleSalesChannels` association resolves to a mapping entity that
is readable only in system scope, so the request fails with:

```
Read access to nested association "bundleSalesChannels" on entity "product" not allowed for scope "crud".
```

Deleting by id, as example 04 does, is unaffected.
