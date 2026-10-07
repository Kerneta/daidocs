import json, os
HERE=os.path.dirname(os.path.abspath(__file__))
gold={str(t["n"]):t["gold_sym"].lower() for t in json.load(open(os.path.join(HERE,"questions/hard_gold.json")))}
pack={str(r["n"]):r for r in json.load(open(os.path.join(HERE,"results/hard_pack.json")))}
ans=json.load(open(os.path.join(HERE,"results/hard_answers.json")))
n=len(gold)
print("\nHard paraphrase E2E (.cai vs Graphify, no XERJ)\n")
print("  %-9s gold_in_pack  solved  avg_tok" % "tool")
out={}
for tool,tokkey,ipkey in (("cai","cai_tok","cai_in_pack"),("gf","gf_tok","gf_in_pack")):
    if tool not in ans: continue
    gip=sum(1 for k in gold if pack[k][ipkey])
    solved=sum(1 for k in gold if ans[tool].get(k,"").lower()==gold[k])
    avgtok=sum(pack[k][tokkey] for k in gold)//n
    out[tool]={"gold_in_pack":gip,"solved":solved,"n":n,"avg_tok":avgtok}
    print("  %-9s %d/%d         %d/%d    %5d" % (tool,gip,n,solved,n,avgtok))
json.dump(out,open(os.path.join(HERE,"results/hard_results.json"),"w"),indent=2)
