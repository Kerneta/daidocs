import json, os
HERE=os.path.dirname(os.path.abspath(__file__))
gold={str(t["n"]):[g.lower() for g in t["gold_set"]] for t in json.load(open(os.path.join(HERE,"questions/change_gold.json")))}
ans=json.load(open(os.path.join(HERE,"results/change_answers.json")))
tok={str(r["n"]):r for r in json.load(open(os.path.join(HERE,"results/change_tokens.json")))}
tkey={"cai":"cai_tok","gf":"gf_tok","raw":"raw_tok"}
print("\nMake-this-change E2E (.cai vs Graphify vs raw, no XERJ): blind edit-set recall vs AST gold\n")
print("  %-8s recall  complete  F1    avg_tok" % "tool")
out={}
for tool in ("cai","gf","raw"):
    rec=comp=f1=0.0; n=len(gold)
    for k,g in gold.items():
        a=set(x.lower() for x in ans[tool].get(k,[])); gs=set(g)
        inter=len(a&gs); r=inter/len(gs); p=inter/len(a) if a else 0
        rec+=r; comp+=1 if gs<=a else 0; f1+=(2*p*r/(p+r)) if (p+r) else 0
    avgtok=sum(tok[k][tkey[tool]] for k in gold)/n
    out[tool]={"recall":round(rec/n,2),"complete":int(comp),"n":n,"f1":round(f1/n,2),"avg_tok":round(avgtok)}
    print("  %-8s %.2f    %d/%d      %.2f  %6d" % (tool,rec/n,int(comp),n,f1/n,avgtok))
json.dump(out,open(os.path.join(HERE,"results/change_results.json"),"w"),indent=2)
