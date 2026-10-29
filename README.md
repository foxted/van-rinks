# van-rinks

One-page view of Vancouver's drop-in rink schedules (public skate, hockey, stick & puck, figure) for the next 7 days.

The city calendar is a JS app on top of a plain JSON API that blocks cross-origin calls, so this is a Cloudflare Worker that proxies that API, caches it for an hour, and renders a mobile-friendly list. No build step, one file.

```
npm i
npm run dev      # http://localhost:8787
npm run deploy   # gives you a workers.dev URL, add it to your phone's home screen
```

Filters are plain links (bookmarkable): `?type=skate|hockey|stick|figure`, `?rink=westend|kits|hillcrest|...`, `?days=14`.
`/api.json` returns the normalized sessions with CORS enabled if you want to build something else on it.

## MCP

`POST /mcp` is a stateless Streamable HTTP MCP server (no auth). In claude.ai: Settings > Connectors > Add custom connector, URL `https://<your-worker>.workers.dev/mcp`. For Claude Code: `claude mcp add --transport http van-rinks https://<your-worker>.workers.dev/mcp`.

Tools: `list_rink_sessions(type?, rink?, days?, date?)` and `list_rinks()`.

## Publishing to the official MCP Registry

`server.json` is a remotes-only entry (no npm package needed). It uses the `com.whatdafox/van-rinks` namespace, which means DNS auth on `whatdafox.com` and a custom domain on the Worker (`rinks.whatdafox.com`, set in the Cloudflare dashboard or `[routes]` in wrangler.toml).

One-time setup:

```bash
# key pair
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "whatdafox.com. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""   # add this TXT record

# publish (after the record propagates)
brew install mcp-publisher
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain whatdafox.com --private-key "${PRIVATE_KEY}"
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=van-rinks"
```

Store that same `PRIVATE_KEY` hex as the `MCP_PRIVATE_KEY` repo secret (plus `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) and `.github/workflows/release.yml` deploys and republishes on every `v*` tag.

If you'd rather skip the custom domain: rename to `io.github.<your-username>/van-rinks`, point `remotes[0].url` at the workers.dev URL, and use `mcp-publisher login github` locally (or `login github-oidc` in Actions).

Upstream: `POST https://anc.ca.apm.activecommunities.com/vancouver/rest/onlinecalendar/multicenter/events` with `calendar_id: 3` and the eight rink `center_ids`. It ignores the date range and returns the whole season.
