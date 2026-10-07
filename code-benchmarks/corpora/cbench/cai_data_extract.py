"""Kerneta .cai structured-data extractor (offline, no LLM).

Turns non-code but structured inputs into the same plain-text .cai store:
  - SQL schema (.sql): tables, columns, foreign-key references
  - Terraform (.tf): resources/variables/modules and their references
  - JSON config (package.json, tsconfig.json): dependencies, extends
  - Package manifests (pyproject.toml, Cargo.toml, go.mod, package.json): dependency edges

Edges reuse the code vocabulary where it fits: contains, references, imports (deps),
depends_on, extends. Run: python cai_data_extract.py <dir> <store>
"""

import json
import os
import re
import sys

try:
    import tomllib
except ModuleNotFoundError:  # py<3.11
    tomllib = None


def extract_sql(text):
    """Return (tables, edges) from a SQL schema via robust regex."""
    tables, edges = [], []
    # CREATE TABLE name ( ... )
    for m in re.finditer(r"create\s+table\s+(?:if\s+not\s+exists\s+)?[\"`\[]?(\w+)[\"`\]]?\s*\((.*?)\);",
                         text, re.I | re.S):
        name, body = m.group(1), m.group(2)
        cols = []
        for line in body.split(","):
            cm = re.match(r"\s*[\"`\[]?(\w+)[\"`\]]?\s+\w", line)
            if cm and cm.group(1).lower() not in ("foreign", "primary", "constraint", "unique", "key"):
                cols.append(cm.group(1))
        tables.append({"name": name, "cols": cols})
        for fk in re.finditer(r"references\s+[\"`\[]?(\w+)[\"`\]]?", body, re.I):
            edges.append({"src": name, "dst": fk.group(1), "type": "references"})
    return tables, edges


def _block_body(text, open_brace_idx):
    """Return the substring between matching braces starting at open_brace_idx."""
    depth, i = 0, open_brace_idx
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_brace_idx + 1:i]
        i += 1
    return text[open_brace_idx + 1:]


def extract_terraform(text):
    """Return (blocks, edges) from HCL via regex, scanning each block body."""
    blocks, edges = [], []
    for m in re.finditer(r'(resource|data|module|variable|output|provider)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{',
                         text):
        kind, a, b = m.group(1), m.group(2), m.group(3)
        addr = "{}.{}".format(a, b) if b else "{}.{}".format(kind, a)
        body = _block_body(text, m.end() - 1)
        blocks.append({"addr": addr, "kind": kind, "body": body})
    addrs = {b["addr"] for b in blocks}
    seen = set()
    for b in blocks:
        for ref in re.finditer(r"\b([a-z_]+\.[a-z0-9_]+(?:\.[a-z0-9_]+)?)\b", b["body"]):
            base = ".".join(ref.group(1).split(".")[:2])
            if base in addrs and base != b["addr"] and (b["addr"], base) not in seen:
                seen.add((b["addr"], base))
                edges.append({"src": b["addr"], "dst": base, "type": "references"})
    return blocks, edges


def deps_from_manifest(path, text):
    """Return list of dependency names from a manifest file."""
    base = os.path.basename(path).lower()
    deps = []
    if base == "package.json" or base.endswith(".json"):
        try:
            data = json.loads(text)
        except ValueError:
            return []
        for key in ("dependencies", "devDependencies"):
            deps += list(data.get(key, {}).keys())
        for ext in ([data.get("extends")] if isinstance(data.get("extends"), str) else data.get("extends", [])):
            if ext:
                deps.append(str(ext))
    elif base in ("pyproject.toml", "cargo.toml") and tomllib:
        try:
            data = tomllib.loads(text)
        except Exception:
            return []
        if base == "pyproject.toml":
            for d in data.get("project", {}).get("dependencies", []):
                deps.append(re.split(r"[<>=!~ \[]", d)[0])
        else:
            deps += list(data.get("dependencies", {}).keys())
    elif base == "go.mod":
        for m in re.finditer(r"^\s*([\w./-]+)\s+v[\d.]", text, re.M):
            deps.append(m.group(1).split("/")[-1])
    return [d for d in deps if d]


def extract_scip(data):
    """Simplified SCIP JSON: documents[].symbols[].relationships -> nodes + edges."""
    nodes, edges = [], []
    for doc in data.get("documents", []):
        for sym in doc.get("symbols", []):
            name = sym.get("symbol", "")
            short = name.rstrip(".").split("/")[-1].split("(")[0] or name
            nodes.append(short)
            for rel in sym.get("relationships", []):
                tgt = rel.get("symbol", "").rstrip(".").split("/")[-1].split("(")[0]
                if not tgt:
                    continue
                typ = ("scip_impl" if rel.get("is_implementation") else
                       "scip_def" if rel.get("is_definition") else "scip_ref")
                edges.append({"src": short, "dst": tgt, "type": typ})
    return list(dict.fromkeys(nodes)), edges


def extract_mcp(data):
    """MCP config: mcpServers -> server/command/package/env nodes + edges."""
    nodes, edges = [], []
    servers = data.get("mcpServers", data.get("mcp", {}).get("servers", {}))
    for name, cfg in servers.items():
        nodes.append(name)
        cmd = cfg.get("command")
        if cmd:
            nodes.append(cmd)
            edges.append({"src": name, "dst": cmd, "type": "references"})
        for a in cfg.get("args", []):
            if isinstance(a, str) and (a.startswith("@") or "/" in a) and not a.startswith("-"):
                pkg = a
                nodes.append(pkg)
                edges.append({"src": name, "dst": pkg, "type": "references"})
                break
        for env in (cfg.get("env", {}) or {}):
            nodes.append(env)
            edges.append({"src": name, "dst": env, "type": "requires_env"})
    return list(dict.fromkeys(nodes)), edges


def extract_cargo_workspace(root_dir):
    """Cargo workspace: internal crate dependency graph (crate_depends_on)."""
    if tomllib is None:
        return [], []
    root = os.path.join(root_dir, "Cargo.toml")
    if not os.path.exists(root):
        return [], []
    try:
        rootdata = tomllib.loads(open(root, encoding="utf-8").read())
    except Exception:
        return [], []
    members = rootdata.get("workspace", {}).get("members", [])
    crates, deps = {}, []
    for mem in members:
        mpath = os.path.join(root_dir, mem, "Cargo.toml")
        if not os.path.exists(mpath):
            continue
        try:
            md = tomllib.loads(open(mpath, encoding="utf-8").read())
        except Exception:
            continue
        cname = md.get("package", {}).get("name")
        if cname:
            crates[cname] = list(md.get("dependencies", {}).keys())
    edges = []
    for c, cdeps in crates.items():
        for d in cdeps:
            if d in crates:
                edges.append({"src": c, "dst": d, "type": "crate_depends_on"})
    return list(crates.keys()), edges


def introspect_postgres(dsn):
    """Live Postgres introspection -> reconstructed DDL -> SQL extraction. Needs psycopg."""
    try:
        import psycopg
    except ModuleNotFoundError:
        raise RuntimeError("psycopg not installed; cannot introspect Postgres")
    ddl = []
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
            tables = [r[0] for r in cur.fetchall()]
            for t in tables:
                cur.execute("""SELECT column_name FROM information_schema.columns
                               WHERE table_name=%s ORDER BY ordinal_position""", (t,))
                cols = [r[0] for r in cur.fetchall()]
                ddl.append("CREATE TABLE {} ({});".format(t, ", ".join(c + " TEXT" for c in cols)))
            cur.execute("""SELECT tc.table_name, ccu.table_name
                           FROM information_schema.table_constraints tc
                           JOIN information_schema.constraint_column_usage ccu
                             ON tc.constraint_name = ccu.constraint_name
                           WHERE tc.constraint_type='FOREIGN KEY'""")
            for src, dst in cur.fetchall():
                ddl.append("ALTER TABLE {} ADD FOREIGN KEY REFERENCES {}(id);".format(src, dst))
    return extract_sql("\n".join(ddl))


def build(src_dir, store):
    os.makedirs(os.path.join(store, "files"), exist_ok=True)
    manifest, symbols, edges = [], [], []
    for name in sorted(os.listdir(src_dir)):
        path = os.path.join(src_dir, name)
        if not os.path.isfile(path):
            continue
        text = open(path, encoding="utf-8", errors="replace").read()
        mod = os.path.splitext(name)[0]
        low = name.lower()
        syms = []
        if low.endswith(".sql"):
            tables, es = extract_sql(text)
            for t in tables:
                syms.append(t["name"])
                symbols.append({"name": t["name"], "kind": "table", "module": mod, "line": 1})
                edges.append({"src": mod, "dst": "{}.{}".format(mod, t["name"]), "type": "contains", "confidence": "EXTRACTED"})
            for e in es:
                edges.append({"src": "{}.{}".format(mod, e["src"]), "dst": "{}.{}".format(mod, e["dst"]),
                              "type": "references", "confidence": "EXTRACTED"})
        elif low.endswith(".tf") or low.endswith(".hcl"):
            blocks, es = extract_terraform(text)
            for b in blocks:
                syms.append(b["addr"])
                symbols.append({"name": b["addr"], "kind": b["kind"], "module": mod, "line": 1})
                edges.append({"src": mod, "dst": "{}.{}".format(mod, b["addr"]), "type": "contains", "confidence": "EXTRACTED"})
            for e in es:
                edges.append({"src": "{}.{}".format(mod, e["src"]), "dst": "{}.{}".format(mod, e["dst"]),
                              "type": "references", "confidence": "EXTRACTED"})
        elif low.endswith(".scip.json") or low.endswith(".scip"):
            try:
                data = json.loads(text)
            except ValueError:
                continue
            nodes, es = extract_scip(data)
            for nn in nodes:
                syms.append(nn)
                symbols.append({"name": nn, "kind": "scip_symbol", "module": mod, "line": 1})
                edges.append({"src": mod, "dst": "{}.{}".format(mod, nn), "type": "contains", "confidence": "EXTRACTED"})
            for e in es:
                edges.append({"src": "{}.{}".format(mod, e["src"]), "dst": "{}.{}".format(mod, e["dst"]),
                              "type": e["type"], "confidence": "EXTRACTED"})
        elif low in (".mcp.json", "mcp.json", "mcp_servers.json", "claude_desktop_config.json"):
            try:
                data = json.loads(text)
            except ValueError:
                continue
            nodes, es = extract_mcp(data)
            for nn in nodes:
                syms.append(nn)
                symbols.append({"name": nn, "kind": "mcp_node", "module": mod, "line": 1})
            for e in es:
                edges.append({"src": "{}.{}".format(mod, e["src"]), "dst": "{}.{}".format(mod, e["dst"]),
                              "type": e["type"], "confidence": "EXTRACTED"})
        elif low in ("package.json", "tsconfig.json", "pyproject.toml", "cargo.toml", "go.mod"):
            for d in deps_from_manifest(path, text):
                syms.append(d)
                edges.append({"src": mod, "dst": d, "type": "depends_on", "confidence": "EXTRACTED"})
            if low == "cargo.toml":
                crates, ces = extract_cargo_workspace(src_dir)
                for c in crates:
                    syms.append(c)
                for e in ces:
                    edges.append({"src": e["src"], "dst": e["dst"], "type": "crate_depends_on", "confidence": "EXTRACTED"})
        else:
            continue
        manifest.append({"module": mod, "path": name, "lang": "data",
                         "summary": "", "symbols": syms, "imports": [], "loc": text.count("\n") + 1})
        with open(os.path.join(store, "files", mod + ".cai"), "w", encoding="utf-8") as f:
            f.write("# .cai data  {}\nfile: {}\nsymbols: {}\n".format(mod, name, ", ".join(syms)))

    with open(os.path.join(store, "manifest.jsonl"), "w", encoding="utf-8") as f:
        for m in manifest:
            f.write(json.dumps(m) + "\n")
    with open(os.path.join(store, "symbols.jsonl"), "w", encoding="utf-8") as f:
        for s in symbols:
            f.write(json.dumps(s) + "\n")
    with open(os.path.join(store, "edges.jsonl"), "w", encoding="utf-8") as f:
        seen = set()
        for e in edges:
            k = (e["src"], e["dst"], e["type"])
            if k not in seen:
                seen.add(k)
                f.write(json.dumps(e) + "\n")
    return len(manifest), len(edges)


if __name__ == "__main__":
    n, e = build(sys.argv[1], sys.argv[2])
    print("extracted {} data files, {} edges into {}".format(n, e, sys.argv[2]))
