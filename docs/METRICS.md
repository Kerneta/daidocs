# Counting adoption

Where the numbers come from, what each one really measures, and how to keep the
ones that expire. The rule behind all of it: the self-hosted tool stays silent
unless a user opts in, so growth is measured from public platform data and from
people who chose to be counted.

## The surfaces

| surface | what it counts | unique users? | where to read it |
|---|---|---|---|
| **npm downloads** | fetches of the `daidocs` package (the `npx daidocs setup` path) | no, inflated by CI, mirrors and cache misses | `https://api.npmjs.org/downloads/point/last-week/daidocs`, npmtrends.com, npm-stat.com |
| **GitHub traffic** | git clones and page views (the `git clone` path) | clones report a unique-cloners count | repo Insights, Traffic; archived to `metrics/*.csv` by the workflow below |
| **GitHub stars and forks** | interest, not installs | n/a | the repo header, star-history.com |
| **MCP registry stats** | installs and calls of the MCP server | per registry | Smithery, Glama, PulseMCP listings |
| **Browser extension stores** | installs and weekly active users of the extension | yes, stores report active users | Chrome Web Store developer dashboard, Firefox Add-ons (AMO) statistics |
| **Opt-in install ping** | first-time installs of the tool, from people who said yes | yes, one random id per install | your ping endpoint, see below |
| **Hosted service (daidocs.com)** | active users of the managed service | yes, they signed up | your own backend |

## Browser extension

When a browser extension ships, its store dashboard is the cleanest usage number
in the whole list: the Chrome Web Store reports total installs and **weekly active
users**, and Firefox AMO reports active daily users, both without any code you
write and both counting real people rather than downloads. Publish under the same
Kerneta identity so the extension, the npm package and the repo read as one
project. Treat the store's active-user figure as the headline "people using it"
number for the extension surface, and keep npm downloads as the headline for the
CLI surface.

## GitHub traffic: keep it past 14 days

GitHub discards traffic older than 14 days. `.github/workflows/traffic.yml` runs
weekly, fetches clones and views through the API, and upserts them into
`metrics/traffic-clones.csv` and `metrics/traffic-views.csv`, committed to the
repo so the history accumulates. Run it by hand any time from the Actions tab.

If the workflow's fetch returns 403, the built-in token lacks traffic access:
create a personal access token with `repo` scope (classic) or `Administration:
read` (fine-grained), and store it as the `TRAFFIC_TOKEN` repository secret.

To archive locally instead:

```bash
GH_TOKEN=<your token> REPO=Kerneta/daidocs node tools/archive_traffic.mjs
```

## The opt-in install ping

The tool asks once, on the first interactive `setup`, whether it may count the
install. Default no, non-interactive runs never send, `DAIDOCS_NO_PING=1` refuses
outright, and the choice is recorded in `~/.daidocs/install.json`. A yes sends one
request and nothing more.

To actually count these, an endpoint has to receive them. The client sends:

```
POST https://daidocs.com/i        (override with DAIDOCS_PING_URL)
content-type: application/json
{ "id": "<random uuid>", "version": "4.4.32", "ts": "<iso timestamp>" }
```

The receiver only has to accept the POST and record the row. Count distinct `id`
values for unique installs, group by `version` for adoption of each release, group
by day for a growth curve. A minimal receiver, for a PHP host such as the current
site:

```php
<?php
// i.php  -- append one line per install ping
$raw = file_get_contents('php://input');
$d = json_decode($raw, true);
if (!$d || empty($d['id'])) { http_response_code(400); exit; }
$line = date('c') . "\t" . preg_replace('/[^0-9a-f-]/','',$d['id'])
      . "\t" . preg_replace('/[^0-9.]/','',$d['version'] ?? '') . "\n";
file_put_contents(__DIR__.'/pings.tsv', $line, FILE_APPEND | LOCK_EX);
http_response_code(204);
```

Until that endpoint exists, the prompt and the opt-in still work; the ping simply
has nowhere to land and fails silently, which is by design.

## What to report publicly

Lead with **npm downloads** and **GitHub unique cloners** for installs, the
**extension store active users** once the extension ships, and keep active-usage
of the service to the hosted dashboard. Every one of those is either public
platform data or a person who opted in, so none of it contradicts the promise
that a self-hosted store never phones home.
