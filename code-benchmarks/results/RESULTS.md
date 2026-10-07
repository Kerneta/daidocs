# Kerneta .cai vs Graphify vs raw files: reproducible results

Built offline from source with the tree-sitter extractor (`engine/cai_ts_extract.py`). Accuracy is correct answers against each suite's own gold; tokens are the average a query puts in front of the model (chars/4, applied identically to every system). Rebuild and verify with `python run_all.py`. XERJ is not included.

## Headline suites

| Suite | Q | .cai | Graphify | raw | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local, 9 languages | 94 | 94/94 | 83/94 | 80/94 | 29.2 | 105.1 | 215.0 | **4x less** | **7x less** |
| Deep multi-hop (constructed) | 11 | 11/11 | 10/11 | 8/11 | 26.9 | 118.3 | 188.0 | **4x less** | **7x less** |
| Real-code retrieval | 10 | 10/10 | 10/10 | 10/10 | 23.8 | 126.1 | 4818.1 | **5x less** | **202x less** |
| psf/requests (ast oracle) | 16 | 16/16 | 13/16 | 16/16 | 55.1 | 689.4 | 9023.4 | **13x less** | **164x less** |

## Per-language

| Language | Q | .cai | Graphify | raw | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| python | 11 | 11/11 | 9/11 | 10/11 | 33.4 | 159.9 | 343.7 | 5x less | 10x less |
| js | 11 | 11/11 | 9/11 | 10/11 | 33.4 | 160.5 | 257.5 | 5x less | 8x less |
| ts | 11 | 11/11 | 9/11 | 10/11 | 33.4 | 160.5 | 257.5 | 5x less | 8x less |
| ruby | 11 | 11/11 | 6/11 | 10/11 | 33.4 | 70.4 | 195.6 | 2x less | 6x less |
| go | 10 | 10/10 | 10/10 | 8/10 | 25.4 | 75.0 | 148.0 | 3x less | 6x less |
| rust | 10 | 10/10 | 10/10 | 8/10 | 25.4 | 76.0 | 163.0 | 3x less | 6x less |
| java | 10 | 10/10 | 10/10 | 8/10 | 25.6 | 77.5 | 195.0 | 3x less | 8x less |
| csharp | 10 | 10/10 | 10/10 | 8/10 | 25.5 | 75.5 | 194.0 | 3x less | 8x less |
| cpp | 10 | 10/10 | 10/10 | 8/10 | 25.5 | 77.2 | 161.0 | 3x less | 6x less |

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

## Scale: CPython standard library (who calls this)

153 modules, 7,469 symbols. Tokens for one reverse-traversal query per symbol: .cai `callers`, Graphify `affected`. Per-query cost tracks the symbol's fan-in, not the store size.

| callers of (stdlib symbol) | .cai tok | Graphify tok | .cai vs Graphify |
| --- | --- | --- | --- |
| partial | 107 | 642 | 6x less |
| wraps | 141 | 311 | 2x less |
| ArgumentParser | 233 | 386 | 2x less |
| reduce | 64 | 232 | 4x less |
| total_ordering | 21 | 66 | 3x less |
| lru_cache | 45 | 62 | 1x less |
| namedtuple | 20 | 57 | 3x less |
| OrderedDict | 20 | 10 | GF smaller (near-zero fan-in) |
| Counter | 19 | 9 | GF smaller (near-zero fan-in) |
| deque | 19 | 8 | GF smaller (near-zero fan-in) |
| **average, 10 symbols** | **69** | **178** | **3x less** |

## httpx semantic + lookup retrieval (.cai vs Graphify)

semantic: a behaviour described in natural language, answer is the implementing symbol. lookup: "where is X defined". Recall = gold file in the retrieved set; tokens chars/4. .cai uses the hybrid lexical + MiniLM retrieval; Graphify a native query. (run_semantic.py)

| Query type | n | .cai recall | .cai top-1 | Graphify recall | .cai tok | Graphify tok | .cai vs Graphify |
| --- | --- | --- | --- | --- | --- | --- | --- |
| semantic | 40 | 100% | 55% | 100% | 1414 | 1841 | 1x less |
| lookup | 25 | 76% | 44% | 100% | 855 | 3698 | 4x less |

## "Make this change" end-to-end (.cai vs Graphify vs raw)

Given a change, surface every function that must be edited (target + direct callers, AST gold). A blind Opus 4.8 agent lists the edit set from each tool's pack alone. A missed caller is a broken build, so recall and complete edit sets are decisive. (run_change.py + grade_change.py)

| Tool | avg recall | complete edit sets | avg F1 | avg tokens |
| --- | --- | --- | --- | --- |
| .cai | 1.00 | 6 / 6 | 0.98 | 38 |
| Graphify | 0.64 | 3 / 6 | 0.71 | 1651 |
| raw | 0.61 | 1 / 6 | 0.72 | 64075 |

## Hard paraphrase end-to-end (.cai vs Graphify)

12 behaviour questions about httpx that never name the target symbol, so the answerer must reason from retrieved code. Gold-in-pack is the solvability ceiling (was the right code retrieved); solved is a blind Opus 4.8 agent graded against the parser's gold. (run_hard.py + grade_hard.py)

| Tool | gold in pack | solved | avg tokens |
| --- | --- | --- | --- |
| .cai | 12 / 12 | 12 / 12 | 1698 |
| Graphify | 11 / 12 | 10 / 12 | 2746 |
