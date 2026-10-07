# Kerneta .cai vs Graphify vs raw files: reproducible results

Built offline from source with the tree-sitter extractor (`engine/cai_ts_extract.py`). Accuracy is correct answers against each suite's own gold; tokens are the average a query puts in front of the model (chars/4, applied identically to every system). Rebuild and verify with `python run_all.py`.

## Headline suites

| Suite | Q | .cai | Graphify | raw | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local, multi-language (4 of 9 langs) | 44 | 44/44 | 33/44 | 40/44 | 33.4 | 137.8 | 263.6 | **4x less** | **8x less** |
| Deep multi-hop (constructed) | 11 | 11/11 | 10/11 | 8/11 | 26.9 | 118.3 | 188.0 | **4x less** | **7x less** |
| Real-code retrieval | 10 | 10/10 | 10/10 | 10/10 | 23.8 | 126.1 | 4818.1 | **5x less** | **202x less** |
| psf/requests (ast oracle) | 16 | 16/16 | 13/16 | 16/16 | 55.1 | 689.4 | 9023.4 | **13x less** | **164x less** |

*Local, 9 languages* aggregates the 4 reproducible languages in this kit (python, js, ts, ruby; 12 questions each). The call-graph languages (go/rust/java/csharp/cpp) need their single-file corpora, not bundled here.

## Per-language (11 questions each)

| Language | .cai | Graphify | raw | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| python | 11/11 | 9/11 | 10/11 | 33.4 | 159.9 | 343.7 | 5x less | 10x less |
| js | 11/11 | 9/11 | 10/11 | 33.4 | 160.5 | 257.5 | 5x less | 8x less |
| ts | 11/11 | 9/11 | 10/11 | 33.4 | 160.5 | 257.5 | 5x less | 8x less |
| ruby | 11/11 | 6/11 | 10/11 | 33.4 | 70.4 | 195.6 | 2x less | 6x less |

## httpx deep-dive: structural queries (.cai vs Graphify vs raw)

Member-recall of the ast-derived answer set; tokens chars/4. raw is the naive dump of every source file (what an agent with no tool reads).

| Query type | n | .cai recall | Graphify recall | raw recall | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| imports | 15 | 100% | 91% | 100% | 22 | 4696 | 64075 | 218x less | 2976x less |
| callers | 12 | 100% | 56% | 100% | 135 | 1738 | 64075 | 13x less | 474x less |
| callees | 12 | 100% | 45% | 100% | 139 | 1087 | 64075 | 8x less | 462x less |
| tdeps | 10 | 100% | 90% | 100% | 228 | 4736 | 64075 | 21x less | 281x less |
| subclasses | 10 | 100% | 100% | 100% | 40 | 2879 | 64075 | 73x less | 1622x less |
| most_imported | 1 | 100% | 0% | 100% | 115 | 7 | 64075 | GF smaller but 0% recall | 557x less |
