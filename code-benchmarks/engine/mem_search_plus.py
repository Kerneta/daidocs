"""Enhanced free-signal retriever for .cai (all stdlib, plain text, zero build cost).

Adds three principled, free techniques over plain BM25:
  1. BM25F field weighting     name > docstring > signature > comments > literals > struct
  2. query expansion           code-domain synonyms + light stemming + identifier split
  3. retrieve-then-rerank      recall-favoring BM25F top-N, then precision bonus for
                               name/signature matches to fix precision@1

Fields are extracted from source with ast/tokenize, so it works with OR without
docstrings (the docstring field is just empty when absent).
"""
import ast
import io
import math
import os
import re
import tokenize as tk

TOKEN_RE = re.compile(r"[A-Za-z0-9]+")
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")

# code-domain synonyms (general, not tuned to any test corpus)
SYN = {
    "money": ["cent", "cents", "dollar", "price", "currency", "amount", "cash"],
    "dollar": ["money", "cent", "currency", "price"],
    "price": ["cost", "money", "amount", "cent", "cents"],
    "add": ["insert", "append", "put", "create", "new"],
    "remove": ["delete", "discard", "pop", "drop"],
    "delete": ["remove", "discard", "drop"],
    "find": ["lookup", "get", "search", "locate", "fetch", "retrieve"],
    "get": ["fetch", "lookup", "retrieve", "find"],
    "total": ["sum", "aggregate", "grand", "subtotal"],
    "discount": ["off", "reduce", "percent", "percentage", "markdown", "rebate"],
    "percent": ["percentage", "rate", "discount"],
    "product": ["item", "goods", "sku"],
    "cart": ["basket", "order", "bag"],
    "format": ["render", "display", "show", "stringify"],
    "compute": ["calculate", "calc", "work", "derive"],
    "calculate": ["compute", "calc", "derive"],
    "line": ["item", "row", "entry"],
    "import": ["depend", "dependency", "require", "use"],
    "call": ["invoke", "caller", "callee"],
    "loyalty": ["tier", "member", "membership", "reward"],
    "tier": ["level", "loyalty", "rank"],
}


def _stem(w):
    for suf in ("ing", "ers", "er", "ed", "es", "s"):
        if len(w) > len(suf) + 2 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def tokenize(text):
    out = []
    for raw in TOKEN_RE.findall(text or ""):
        for p in _CAMEL.sub(" ", raw).split():
            for seg in p.split("_"):
                if seg:
                    out.append(_stem(seg.lower()))
        out.append(_stem(raw.lower()))
    return out


def expand_query(q):
    base = tokenize(q)
    exp = list(base)
    qlow = set(base)
    for word, syns in SYN.items():
        if _stem(word) in qlow:
            exp.extend(_stem(s) for s in syns)
    return exp


# ------------------------------------------------------------- field extraction
FIELDS = ("name", "doc", "sig", "com", "lit", "struct", "body")
WEIGHTS = {"name": 3.0, "doc": 2.5, "sig": 2.0, "com": 1.5, "lit": 1.0, "struct": 1.0, "body": 0.7}


def extract_fields(src, module, symbols, imports):
    f = {k: "" for k in FIELDS}
    f["name"] = module + " " + " ".join(symbols)
    f["struct"] = " ".join(imports)
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return f
    docs, sigs, strings = [], [], []
    doc_ids = set()
    md = ast.get_docstring(tree)
    if md:
        docs.append(md)
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            d = ast.get_docstring(n)
            if d:
                docs.append(d)
            if (n.body and isinstance(n.body[0], ast.Expr)
                    and isinstance(n.body[0].value, ast.Constant)
                    and isinstance(n.body[0].value.value, str)):
                doc_ids.add(id(n.body[0].value))
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = [a.arg for a in (n.args.posonlyargs + n.args.args + n.args.kwonlyargs)]
            sigs.append(n.name + " " + " ".join(args))
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in doc_ids:
            if n.value.strip():
                strings.append(n.value)
    comments = []
    try:
        for t in tk.generate_tokens(io.StringIO(src).readline):
            if t.type == tk.COMMENT:
                comments.append(t.string.lstrip("#").strip())
    except tk.TokenError:
        pass
    f["doc"] = " ".join(docs)
    f["sig"] = " ".join(sigs)
    f["lit"] = " ".join(strings)
    f["com"] = " ".join(comments)
    return f


# ------------------------------------------------------------- BM25F
class BM25F:
    def __init__(self, docs_fields, weights=WEIGHTS, k1=1.4, b=0.75):
        self.k1, self.b, self.w = k1, b, weights
        self.docs = docs_fields
        self.N = len(docs_fields)
        self.ftok = [{fld: tokenize(d.get(fld, "")) for fld in FIELDS} for d in docs_fields]
        self.flen = {fld: [len(t[fld]) for t in self.ftok] for fld in FIELDS}
        self.favg = {fld: (sum(self.flen[fld]) / self.N if self.N else 0) for fld in FIELDS}
        df = {}
        for t in self.ftok:
            seen = set()
            for fld in FIELDS:
                seen.update(t[fld])
            for term in seen:
                df[term] = df.get(term, 0) + 1
        self.idf = {t: max(1e-6, math.log(1 + (self.N - n + 0.5) / (n + 0.5))) for t, n in df.items()}

    def scores(self, qterms):
        out = [0.0] * self.N
        qset = list(dict.fromkeys(qterms))
        for i in range(self.N):
            s = 0.0
            for term in qset:
                wtf = 0.0
                for fld in FIELDS:
                    tf = self.ftok[i][fld].count(term)
                    if not tf:
                        continue
                    denom = 1 - self.b + self.b * (self.flen[fld][i] / self.favg[fld] if self.favg[fld] else 0)
                    wtf += self.w[fld] * tf / denom
                if wtf:
                    s += self.idf.get(term, 0.0) * (wtf * (self.k1 + 1)) / (wtf + self.k1)
            out[i] = s
        return out


def rerank(cands, docs_fields, qterms):
    """Precision bonus: query terms hitting the name/sig fields push a candidate up."""
    qset = set(qterms)
    out = []
    for i, base in cands:
        name_tok = set(tokenize(docs_fields[i]["name"]))
        sig_tok = set(tokenize(docs_fields[i]["sig"]))
        bonus = 2.0 * len(qset & name_tok) + 1.0 * len(qset & sig_tok)
        out.append((i, base + bonus))
    out.sort(key=lambda x: x[1], reverse=True)
    return out
