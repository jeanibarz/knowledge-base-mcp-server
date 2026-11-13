"""Write the paired-significance family manifests for #1047 and #1049.

Run after both aggregate.py scripts (it reads reranker-bakeoff/summary.json to
skip cells marked invalid), then feed each manifest to
`node build/benchmarks/significance.js --family=<manifest> --correction=holm`.
"""
import glob, json, os
E = os.path.dirname(os.path.abspath(__file__))
K = os.path.join(os.path.dirname(E), 'reranker-bakeoff')
DS = ['scifact', 'nfcorpus', 'arguana']
def one(root, pattern):
    g = glob.glob(os.path.join(root, pattern))
    return os.path.relpath(g[0], root) if g else None
# Part A: each embedder vs the default, per dataset
fam = []
q = 'runs/dengcao_Qwen3-Embedding-0.6B_Q8_0'
for slug in sorted(os.listdir(os.path.join(E, 'runs'))):
    if slug.startswith('dengcao'): continue
    for ds in DS:
        b = one(E, f'{q}/kb-{ds}-dense-chunk-results.json'); c = one(E, f'runs/{slug}/kb-{ds}-dense-chunk-results.json')
        if b and c: fam.append({'label': f'{slug} vs qwen3 ({ds})', 'baseline': b, 'current': c})
json.dump(fam, open(os.path.join(E, 'significance-family.json'), 'w'), indent=2)
# Part B
summ = json.load(open(os.path.join(K, 'summary.json')))
def valid(v, ds):
    c = summ['variants'].get(v, {}).get('datasets', {}).get(ds)
    return c is not None and c.get('valid', True)
V = ['minilm-l6', 'mxbai-xsmall-v1', 'jina-v1-turbo-en', 'bge-base', 'mxbai-base-v1', 'bge-v2-m3-fp16']
for name, base in [('vs-hybrid', 'hybrid'), ('vs-minilm', 'minilm-l6')]:
    fam = []
    for v in V:
        if v == base: continue
        for ds in DS:
            b = one(K, f'runs/{ds}/{base}/kb-*-results.json'); c = one(K, f'runs/{ds}/{v}/kb-*-results.json')
            if b and c and valid(v, ds) and (base == 'hybrid' or valid(base, ds)):
                fam.append({'label': f'{v} vs {base} ({ds})', 'baseline': b, 'current': c})
    json.dump(fam, open(os.path.join(K, f'significance-family-{name}.json'), 'w'), indent=2)
print('ok')
