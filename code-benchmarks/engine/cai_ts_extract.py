"""Kerneta .cai multi-language extractor (tree-sitter), v3.

Deterministic, offline, no LLM. Adds, toward Graphify parity:
  - node kinds: fn, method, class, struct, interface, enum, trait, namespace,
    module, enum_member, rationale (docstrings)
  - edges: contains, method, calls, imports, imports_from, extends, implements,
    embeds, mixes_in, case_of, references (type refs), rationale_for
  - confidence: EXTRACTED (local or imported), INFERRED (resolved by global
    uniqueness, not imported), AMBIGUOUS (name defined in several modules)
  - fact-based cross-file resolution: per-file import scope with aliases

Run: python cai_ts_extract.py <corpus_dir> <store_dir>
"""

import hashlib
import json
import os
import sys

from tree_sitter import Language, Parser
import tree_sitter_python, tree_sitter_javascript, tree_sitter_typescript
import tree_sitter_go, tree_sitter_rust, tree_sitter_java
import tree_sitter_c, tree_sitter_cpp, tree_sitter_ruby, tree_sitter_c_sharp


def _lang(mod, attr="language"):
    return Language(getattr(mod, attr)())


LANGS = {
    "python": _lang(tree_sitter_python),
    "javascript": _lang(tree_sitter_javascript),
    "typescript": _lang(tree_sitter_typescript, "language_typescript"),
    "go": _lang(tree_sitter_go),
    "rust": _lang(tree_sitter_rust),
    "java": _lang(tree_sitter_java),
    "c": _lang(tree_sitter_c),
    "cpp": _lang(tree_sitter_cpp),
    "ruby": _lang(tree_sitter_ruby),
    "csharp": _lang(tree_sitter_c_sharp),
}

EXT = {
    ".py": "python", ".js": "javascript", ".mjs": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".go": "go", ".rs": "rust", ".java": "java",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
    ".rb": "ruby", ".cs": "csharp",
}

SPEC = {
    "python": {"func": {"function_definition"}, "class": {"class_definition"},
               "call": {"call"}, "import": {"import_statement", "import_from_statement"}},
    "javascript": {"func": {"function_declaration"}, "class": {"class_declaration"},
                   "method": {"method_definition"},
                   "call": {"call_expression", "new_expression"}, "import": {"import_statement"}},
    "typescript": {"func": {"function_declaration"}, "class": {"class_declaration"},
                   "iface": {"interface_declaration"}, "enum": {"enum_declaration"},
                   "method": {"method_definition"},
                   "call": {"call_expression", "new_expression"}, "import": {"import_statement"}},
    "go": {"func": {"function_declaration", "method_declaration"}, "type": {"type_spec"},
           "call": {"call_expression"}, "import": {"import_declaration"}},
    "rust": {"func": {"function_item"}, "class": {"struct_item", "enum_item", "trait_item"},
             "impl": {"impl_item"}, "call": {"call_expression", "macro_invocation"},
             "import": {"use_declaration"}},
    "java": {"func": {"method_declaration", "constructor_declaration"},
             "class": {"class_declaration", "interface_declaration", "enum_declaration"},
             "call": {"method_invocation", "object_creation_expression"},
             "import": {"import_declaration"}},
    "c": {"func": {"function_definition"}, "call": {"call_expression"}, "import": {"preproc_include"}},
    "cpp": {"func": {"function_definition"}, "class": {"class_specifier", "struct_specifier"},
            "call": {"call_expression"}, "import": {"preproc_include"}},
    "ruby": {"func": {"method", "singleton_method"}, "class": {"class", "module"},
             "call": {"call", "method_call"}, "import": {"call"}},
    "csharp": {"func": {"method_declaration", "constructor_declaration", "local_function_statement"},
               "class": {"class_declaration", "interface_declaration", "struct_declaration"},
               "call": {"invocation_expression", "object_creation_expression"},
               "import": {"using_directive"}},
}

# tree-sitter node type -> our node kind
KIND_MAP = {
    "struct_item": "struct", "struct_specifier": "struct", "struct_declaration": "struct",
    "interface_declaration": "interface", "interface_type": "interface",
    "enum_item": "enum", "enum_declaration": "enum",
    "trait_item": "trait",
    "class_definition": "class", "class_declaration": "class", "class_specifier": "class",
    "class": "class", "module": "module",
}
TYPE_KINDS = {"class", "struct", "interface", "enum", "trait", "namespace"}

IDENT_TYPES = {"identifier", "type_identifier", "field_identifier", "constant",
               "property_identifier", "name", "scoped_type_identifier"}
C_NAME_TYPES = IDENT_TYPES | {"qualified_identifier", "destructor_name", "operator_name"}

EXTRACTED, INFERRED, AMBIGUOUS = "EXTRACTED", "INFERRED", "AMBIGUOUS"


def txt(src, node):
    return src[node.start_byte:node.end_byte].decode("utf-8", "replace")


def _walk(node, depth=10**9):
    stack = [(node, 0)]
    while stack:
        n, d = stack.pop()
        yield n
        if d < depth:
            for c in n.named_children:
                stack.append((c, d + 1))


def node_name(src, node):
    c = node.child_by_field_name("name")
    if c is not None and c.type in IDENT_TYPES:
        return txt(src, c)
    d = node.child_by_field_name("declarator")
    depth = 0
    while d is not None and depth < 8:
        if d.type in C_NAME_TYPES:
            return txt(src, d)
        nxt = d.child_by_field_name("declarator")
        if nxt is None:
            ident = next((x for x in d.named_children if x.type in C_NAME_TYPES), None)
            return txt(src, ident) if ident is not None else None
        d = nxt
        depth += 1
    for cc in node.named_children:
        if cc.type in IDENT_TYPES:
            return txt(src, cc)
    return None


def last_ident(name_text):
    for sep in ("::", "->", "."):
        if sep in name_text:
            name_text = name_text.split(sep)[-1]
    return name_text.split("(")[0].split("<")[0].split("!")[0].strip()


def kind_of(node_type, default):
    return KIND_MAP.get(node_type, default)


def collect_calls(src, body, spec):
    names, seen = [], set()
    for n in _walk(body):
        if n.type in spec.get("call", set()):
            fn = n.child_by_field_name("function") or n.child_by_field_name("name") \
                 or n.child_by_field_name("method") or n.child_by_field_name("constructor") \
                 or (n.named_children[0] if n.named_children else None)
            if fn is not None:
                nm = last_ident(txt(src, fn))
                if nm == "new":
                    r = n.child_by_field_name("receiver")
                    if r is not None:
                        nm = last_ident(txt(src, r))
                if nm and nm not in seen:
                    seen.add(nm)
                    names.append(nm)
    return names


def collect_type_refs(src, node):
    """Type names used in a function's parameters / return type."""
    refs, seen = [], set()
    for field in ("parameters", "return_type", "type", "parameter_list"):
        c = node.child_by_field_name(field)
        if c is None:
            continue
        for d in _walk(c):
            if d.type in ("type_identifier", "constant", "scoped_type_identifier", "identifier"):
                nm = last_ident(txt(src, d))
                if nm and nm not in seen:
                    seen.add(nm)
                    refs.append(nm)
    return refs


def collect_arg_idents(src, node):
    """Identifiers passed as call arguments (candidates for indirect_call)."""
    out = set()
    for n in _walk(node):
        if n.type in ("argument_list", "arguments"):
            for c in n.named_children:
                if c.type == "identifier":
                    out.add(txt(src, c))
    return out


def collect_dynamic(src, root, lang):
    """Dynamic import targets: importlib.import_module / __import__ / import()."""
    targets = []
    for n in _walk(root):
        if lang == "python" and n.type == "call":
            f = n.child_by_field_name("function")
            if f is not None and last_ident(txt(src, f)) in ("import_module", "__import__"):
                for d in _walk(n):
                    if d.type == "string_content":
                        targets.append(last_ident(txt(src, d)))
        elif lang in ("javascript", "typescript") and n.type == "call_expression":
            f = n.child_by_field_name("function")
            if f is not None and txt(src, f) == "import":
                for d in _walk(n):
                    if d.type == "string_fragment":
                        targets.append(os.path.splitext(os.path.basename(txt(src, d)))[0])
    return list(dict.fromkeys(targets))


def collect_reexports(src, root, lang):
    """JS/TS `export {X} from './m'` -> (source_module)."""
    out = []
    if lang not in ("javascript", "typescript"):
        return out
    for n in _walk(root):
        if n.type == "export_statement":
            s = n.child_by_field_name("source")
            if s is not None:
                out.append(os.path.splitext(os.path.basename(txt(src, s).strip("\"'")))[0])
    return list(dict.fromkeys(out))


def collect_relations(src, node, lang):
    """Return extends[], implements[], embeds[], mixes_in[] for a class-like node."""
    ext, impl, emb, mix = [], [], [], []
    self_name = node_name(src, node)

    def ids(n, types=("type_identifier", "identifier", "constant")):
        return [txt(src, d) for d in _walk(n) if d.type in types]

    if lang == "python":
        sc = node.child_by_field_name("superclasses")
        if sc is not None:
            ext += [txt(src, c) for c in sc.named_children if c.type in IDENT_TYPES]
    elif lang == "java":
        c = node.child_by_field_name("superclass")
        if c is not None:
            ext += [txt(src, d) for d in _walk(c) if d.type == "type_identifier"]
        c = node.child_by_field_name("interfaces")
        if c is not None:
            impl += [txt(src, d) for d in _walk(c) if d.type == "type_identifier"]
    elif lang in ("javascript", "typescript"):
        for c in _walk(node, depth=3):
            if c.type in ("class_heritage", "extends_clause"):
                ext += [txt(src, d) for d in _walk(c) if d.type in ("identifier", "type_identifier")]
            elif c.type == "implements_clause":
                impl += [txt(src, d) for d in _walk(c) if d.type in ("identifier", "type_identifier")]
    elif lang == "cpp":
        for c in _walk(node, depth=3):
            if c.type == "base_class_clause":
                ext += [txt(src, d) for d in _walk(c) if d.type in ("type_identifier", "identifier")]
    elif lang == "csharp":
        for c in _walk(node, depth=3):
            if c.type == "base_list":
                ext += [txt(src, d) for d in _walk(c) if d.type == "identifier"]
    elif lang == "ruby":
        sc = node.child_by_field_name("superclass")
        if sc is not None:
            ext += ids(sc, ("constant", "identifier"))
        # include Mod -> mixes_in
        for c in _walk(node):
            if c.type == "call":
                m = c.child_by_field_name("method")
                if m is not None and txt(src, m) in ("include", "prepend", "extend"):
                    args = c.child_by_field_name("arguments")
                    if args is not None:
                        mix += ids(args, ("constant",))
    elif lang == "go":
        # struct embedding: a field_declaration with no field name
        for fld in _walk(node):
            if fld.type == "field_declaration" and fld.child_by_field_name("name") is None:
                for d in fld.named_children:
                    if d.type in ("type_identifier", "qualified_type"):
                        emb.append(last_ident(txt(src, d)))

    def clean(xs):
        o, s = [], set()
        for x in xs:
            if x and x != self_name and x not in s:
                s.add(x); o.append(x)
        return o
    return clean(ext), clean(impl), clean(emb), clean(mix)


def collect_enum_members(src, node, lang):
    members = []
    for c in _walk(node, depth=3):
        if c.type in ("enum_variant", "enum_constant", "enum_member_declaration"):
            nm = node_name(src, c) or next((txt(src, d) for d in c.named_children
                                            if d.type in IDENT_TYPES), None)
            if nm:
                members.append(nm)
    return members


def collect_doc(src, node, lang):
    """Docstring (Python) as a rationale string; empty if none."""
    if lang == "python":
        body = node.child_by_field_name("body")
        if body is not None and body.named_children:
            first = body.named_children[0]
            if first.type == "expression_statement" and first.named_children:
                s = first.named_children[0]
                if s.type == "string":
                    doc = txt(src, s).strip("\"'").strip()
                    return doc.splitlines()[0][:120] if doc else ""
    return ""


def collect_imports(src, root, lang):
    """Return (modules, symbols, facts). facts: (local_name, src_module, src_symbol)."""
    mods, syms, facts = [], [], []
    for n in _walk(root):
        if lang == "python" and n.type in ("import_statement", "import_from_statement"):
            if n.type == "import_from_statement":
                mn = n.child_by_field_name("module_name")
                mod = last_ident(txt(src, mn)) if mn is not None else None
                pure_relative = not mod  # `from . import X`: X are sibling modules
                if mod:
                    mods.append(mod)
                for c in n.named_children:
                    if c is mn:
                        continue
                    if c.type == "aliased_import":
                        nm = c.child_by_field_name("name")
                        al = c.child_by_field_name("alias")
                        if nm is not None:
                            orig = last_ident(txt(src, nm))
                            local = txt(src, al) if al is not None else orig
                            if pure_relative:
                                mods.append(orig)
                                facts.append((local, orig, None))
                            else:
                                syms.append(orig)
                                facts.append((local, mod, orig))
                    elif c.type == "dotted_name":
                        orig = last_ident(txt(src, c))
                        if pure_relative:
                            mods.append(orig)
                            facts.append((orig, orig, None))
                        else:
                            syms.append(orig)
                            facts.append((orig, mod, orig))
            else:
                for c in n.named_children:
                    if c.type == "aliased_import":
                        nm = c.child_by_field_name("name")
                        al = c.child_by_field_name("alias")
                        if nm is not None:
                            orig = last_ident(txt(src, nm))
                            local = txt(src, al) if al is not None else orig
                            mods.append(orig)
                            facts.append((local, orig, None))
                    elif c.type == "dotted_name":
                        orig = last_ident(txt(src, c))
                        mods.append(orig)
                        facts.append((orig, orig, None))
        elif lang in ("javascript", "typescript") and n.type == "import_statement":
            s = n.child_by_field_name("source")
            mod = os.path.splitext(os.path.basename(txt(src, s).strip("\"'"))) [0] if s is not None else None
            if mod:
                mods.append(mod)
            for d in _walk(n):
                if d.type == "import_specifier":
                    nm = d.child_by_field_name("name")
                    al = d.child_by_field_name("alias")
                    if nm is not None:
                        orig = last_ident(txt(src, nm))
                        local = txt(src, al) if al is not None else orig
                        syms.append(orig)
                        facts.append((local, mod, orig))
        elif lang == "go" and n.type == "import_declaration":
            for d in _walk(n):
                if d.type == "interpreted_string_literal":
                    mods.append(last_ident(txt(src, d).strip("\"")))
        elif lang == "rust" and n.type == "use_declaration":
            ids = [txt(src, d) for d in _walk(n) if d.type == "identifier"]
            if ids:
                mods.append(ids[0])
                syms.append(ids[-1])
                facts.append((ids[-1], ids[0], ids[-1]))
        elif lang == "java" and n.type == "import_declaration":
            ids = [txt(src, d) for d in _walk(n) if d.type == "identifier"]
            if ids:
                mods.append(ids[-1]); syms.append(ids[-1])
        elif lang in ("c", "cpp") and n.type == "preproc_include":
            for d in n.named_children:
                if d.type in ("string_literal", "system_lib_string"):
                    mods.append(os.path.splitext(os.path.basename(txt(src, d).strip("\"<>")))[0])
        elif lang == "csharp" and n.type == "using_directive":
            ids = [txt(src, d) for d in _walk(n) if d.type == "identifier"]
            if ids:
                mods.append(ids[-1])
        elif lang == "ruby" and n.type == "call":
            m = n.child_by_field_name("method")
            if m is not None and txt(src, m) in ("require", "require_relative"):
                for d in _walk(n):
                    if d.type == "string_content":
                        mods.append(last_ident(txt(src, d)))

    def dedup(xs):
        o, s = [], set()
        for x in xs:
            if x and x not in s:
                s.add(x); o.append(x)
        return o
    return dedup(mods), dedup(syms), facts


def extract_file(path, module, lang):
    src = open(path, "rb").read()
    root = Parser(LANGS[lang]).parse(src).root_node
    spec = SPEC[lang]
    sha1 = hashlib.sha1(src).hexdigest()[:12]
    func_types = spec.get("func", set())
    class_types = spec.get("class", set()) | spec.get("iface", set()) | spec.get("type", set()) | spec.get("enum", set())
    method_types = spec.get("method", set()) or func_types

    symbols, consumed = [], set()
    for node in _walk(root):
        if node.type in class_types:
            cname = node_name(src, node)
            if not cname:
                continue
            kind = kind_of(node.type, "class")
            # go: type_declaration wraps struct/interface; refine kind
            if lang == "go":
                for d in _walk(node, depth=3):
                    if d.type == "struct_type":
                        kind = "struct"
                    elif d.type == "interface_type":
                        kind = "interface"
            ext, impl, emb, mix = collect_relations(src, node, lang)
            methods = []
            for sub in _walk(node):
                if sub is node:
                    continue
                if sub.type in method_types or sub.type in func_types:
                    mname = node_name(src, sub)
                    if mname:
                        methods.append({"kind": "method", "name": mname,
                                        "line": sub.start_point[0] + 1, "end": sub.end_point[0] + 1,
                                        "calls": collect_calls(src, sub, spec),
                                        "doc": collect_doc(src, sub, lang),
                                        "trefs": collect_type_refs(src, sub),
                                        "arg_refs": collect_arg_idents(src, sub)})
                        consumed.add(sub.id)
            symbols.append({"kind": kind, "name": cname,
                            "line": node.start_point[0] + 1, "end": node.end_point[0] + 1,
                            "extends": ext, "implements": impl, "embeds": emb, "mixes_in": mix,
                            "members": collect_enum_members(src, node, lang) if kind == "enum" else [],
                            "doc": collect_doc(src, node, lang), "calls": [], "trefs": [],
                            "arg_refs": set(), "methods": methods})

    for node in _walk(root):
        if node.type in func_types and node.id not in consumed:
            fname = node_name(src, node)
            if not fname:
                continue
            symbols.append({"kind": "fn", "name": fname,
                            "line": node.start_point[0] + 1, "end": node.end_point[0] + 1,
                            "extends": [], "implements": [], "embeds": [], "mixes_in": [], "members": [],
                            "doc": collect_doc(src, node, lang),
                            "calls": collect_calls(src, node, spec),
                            "trefs": collect_type_refs(src, node),
                            "arg_refs": collect_arg_idents(src, node), "methods": []})

    mods, syms, facts = collect_imports(src, root, lang)
    return {"module": module, "path": os.path.basename(path), "lang": lang, "sha1": sha1,
            "imports": mods, "import_syms": syms, "import_facts": facts,
            "dyn": collect_dynamic(src, root, lang), "reexp": collect_reexports(src, root, lang),
            "symbols": symbols, "loc": src.count(b"\n") + 1}


def render_cai(rec):
    L = ["# .cai  kerneta code-ai memory  v3 ({})".format(rec["lang"]),
         "file: {}".format(rec["path"]), "lang: {}".format(rec["lang"]),
         "sha1: {}".format(rec["sha1"]), "loc: {}".format(rec["loc"]), "", "## imports"]
    L += ["- " + m for m in rec["imports"]] or ["- (none)"]
    L += ["", "## symbols"]
    for s in rec["symbols"]:
        if s["kind"] in TYPE_KINDS or s["kind"] == "module":
            rel = []
            if s["extends"]:
                rel.append("extends " + ", ".join(s["extends"]))
            if s["implements"]:
                rel.append("implements " + ", ".join(s["implements"]))
            if s["embeds"]:
                rel.append("embeds " + ", ".join(s["embeds"]))
            if s["mixes_in"]:
                rel.append("mixes_in " + ", ".join(s["mixes_in"]))
            tail = "  " + "; ".join(rel) if rel else ""
            L.append("- {} {}  [L{}-L{}]{}".format(s["kind"], s["name"], s["line"], s["end"], tail))
            if s["doc"]:
                L.append("    doc: {}".format(s["doc"]))
            for m in s["members"]:
                L.append("  - member {}".format(m))
            for m in s["methods"]:
                L.append("  - method {}  [L{}-L{}]".format(m["name"], m["line"], m["end"]))
                if m["calls"]:
                    L.append("      calls: {}".format(", ".join(m["calls"])))
        else:
            L.append("- fn {}  [L{}-L{}]".format(s["name"], s["line"], s["end"]))
            if s["doc"]:
                L.append("    doc: {}".format(s["doc"]))
            if s["calls"]:
                L.append("    calls: {}".format(", ".join(s["calls"])))
    return "\n".join(L) + "\n"


def build(corpus_dir, store_dir):
    files_dir = os.path.join(store_dir, "files")
    os.makedirs(files_dir, exist_ok=True)
    records = []
    for name in sorted(os.listdir(corpus_dir)):
        ext = os.path.splitext(name)[1]
        if ext in EXT:
            records.append(extract_file(os.path.join(corpus_dir, name),
                                        os.path.splitext(name)[0], EXT[ext]))

    modules = {r["module"] for r in records}
    # global maps
    name_modules = {}      # symbol name -> set of modules defining it
    local_defs = {}        # module -> set of names it defines
    type_names = set()     # names whose kind is a type
    fn_names = set()       # names that are functions or methods (callable)
    iface_methods = {}     # (module, iface_name) -> set(method names)
    for rec in records:
        local_defs[rec["module"]] = set()
        for s in rec["symbols"]:
            name_modules.setdefault(s["name"], set()).add(rec["module"])
            local_defs[rec["module"]].add(s["name"])
            if s["kind"] in TYPE_KINDS:
                type_names.add(s["name"])
            if s["kind"] == "fn":
                fn_names.add(s["name"])
            if s["kind"] == "interface":
                iface_methods[(rec["module"], s["name"])] = {m["name"] for m in s["methods"]}
            for m in s["methods"]:
                fn_names.add(m["name"])
                name_modules.setdefault(m["name"], set()).add(rec["module"])
                local_defs[rec["module"]].add(m["name"])
            for mem in s.get("members", []):
                name_modules.setdefault(mem, set()).add(rec["module"])
                local_defs[rec["module"]].add(mem)

    import_scope = {}  # module -> {local_name: (src_module, src_symbol)}
    for rec in records:
        sc = {}
        for local, smod, ssym in rec["import_facts"]:
            sc[local] = (smod, ssym)
        import_scope[rec["module"]] = sc

    def resolve(mod, name):
        """Return (target_module, target_name, confidence) or None."""
        if name in local_defs.get(mod, ()):
            return mod, name, EXTRACTED
        sc = import_scope.get(mod, {})
        if name in sc:
            smod, ssym = sc[name]
            tgt = ssym or name
            if smod in name_modules.get(tgt, ()):
                return smod, tgt, EXTRACTED
            return None
        mods = name_modules.get(name)
        if mods:
            if len(mods) == 1:
                return next(iter(mods)), name, INFERRED
            return sorted(mods)[0], name, AMBIGUOUS
        return None

    man = open(os.path.join(store_dir, "manifest.jsonl"), "w", encoding="utf-8")
    sym = open(os.path.join(store_dir, "symbols.jsonl"), "w", encoding="utf-8")
    edges = []

    def add_edge(src, dst, typ, conf):
        edges.append({"src": src, "dst": dst, "type": typ, "confidence": conf})

    def resolve_calls(owner_mod, owner_name, calls):
        for callee in calls:
            r = resolve(owner_mod, callee)
            if r:
                tmod, tname, conf = r
                add_edge("{}.{}".format(owner_mod, owner_name),
                         "{}.{}".format(tmod, tname), "calls", conf)

    def resolve_named(owner, name, typ):
        r = resolve(owner.split(".")[0], name)
        if r:
            tmod, tname, conf = r
            add_edge(owner, "{}.{}".format(tmod, tname), typ, conf)

    impl_map = {}  # interface id -> [implementing class ids]

    def emit_indirect(owner_id, owner_mod, arg_refs, direct_calls, self_name):
        for r in arg_refs:
            if r in fn_names and r not in direct_calls and r != self_name:
                res = resolve(owner_mod, r)
                if res:
                    add_edge(owner_id, "{}.{}".format(res[0], res[1]), "indirect_call", INFERRED)

    for rec in records:
        m = rec["module"]
        with open(os.path.join(files_dir, m + ".cai"), "w", encoding="utf-8") as f:
            f.write(render_cai(rec))
        names = []
        for s in rec["symbols"]:
            names.append(s["name"])
            names += [mm["name"] for mm in s["methods"]]
        man.write(json.dumps({"module": m, "path": rec["path"], "lang": rec["lang"],
                              "summary": "", "symbols": names,
                              "imports": rec["imports"], "loc": rec["loc"]}) + "\n")
        # module import edges
        for imp in rec["imports"]:
            if imp in modules:
                add_edge(m, imp, "imports", EXTRACTED)
        for local, smod, ssym in rec["import_facts"]:
            tgt = ssym or local
            if smod in modules and tgt in name_modules and smod in name_modules[tgt]:
                add_edge(m, "{}.{}".format(smod, tgt), "imports_from", EXTRACTED)
                if smod != m:
                    add_edge(m, smod, "imports", EXTRACTED)

        for s in rec["symbols"]:
            sid = "{}.{}".format(m, s["name"])
            sym.write(json.dumps({"name": s["name"], "kind": s["kind"], "module": m, "line": s["line"]}) + "\n")
            add_edge(m, sid, "contains", EXTRACTED)
            if s["doc"]:
                add_edge("{}::doc".format(sid), sid, "rationale_for", EXTRACTED)
            resolve_calls(m, s["name"], s["calls"])
            emit_indirect(sid, m, s.get("arg_refs", set()), set(s["calls"]), s["name"])
            for b in s["extends"]:
                resolve_named(sid, b, "extends")
            for b in s["implements"]:
                r = resolve(m, b)
                if r:
                    iid = "{}.{}".format(r[0], r[1])
                    add_edge(sid, iid, "implements", r[2])
                    impl_map.setdefault(iid, []).append(sid)
            for b in s["embeds"]:
                resolve_named(sid, b, "embeds")
            for b in s["mixes_in"]:
                resolve_named(sid, b, "mixes_in")
            for t in s.get("trefs", []):
                if t in type_names and t != s["name"]:
                    resolve_named(sid, t, "references")
            for mem in s.get("members", []):
                memid = "{}.{}".format(m, mem)
                sym.write(json.dumps({"name": mem, "kind": "enum_member", "module": m, "line": s["line"]}) + "\n")
                add_edge(memid, sid, "case_of", EXTRACTED)
            for mm in s["methods"]:
                sym.write(json.dumps({"name": mm["name"], "kind": "method", "module": m, "line": mm["line"]}) + "\n")
                add_edge(sid, "{}.{}".format(m, mm["name"]), "method", EXTRACTED)
                resolve_calls(m, mm["name"], mm["calls"])
                emit_indirect("{}.{}".format(m, mm["name"]), m, mm.get("arg_refs", set()),
                              set(mm["calls"]), mm["name"])
                for t in mm.get("trefs", []):
                    if t in type_names:
                        resolve_named("{}.{}".format(m, mm["name"]), t, "references")

    # module-level dynamic imports and re-exports
    for rec in records:
        for t in rec.get("dyn", []):
            if t in modules:
                add_edge(rec["module"], t, "dynamic_import", INFERRED)
        for s in rec.get("reexp", []):
            if s in modules:
                add_edge(rec["module"], s, "re_exports", EXTRACTED)
    # dispatches_to: interface with exactly one implementer -> that class
    for iid, impls in impl_map.items():
        if len(impls) == 1:
            add_edge(iid, impls[0], "dispatches_to", INFERRED)

    man.close(); sym.close()
    with open(os.path.join(store_dir, "edges.jsonl"), "w", encoding="utf-8") as f:
        seen = set()
        for e in edges:
            k = (e["src"], e["dst"], e["type"])
            if k not in seen:
                seen.add(k)
                f.write(json.dumps(e) + "\n")
    return len(records), len(edges)


if __name__ == "__main__":
    n, e = build(sys.argv[1], sys.argv[2])
    print("built {} .cai files, {} edges into {}".format(n, e, sys.argv[2]))
