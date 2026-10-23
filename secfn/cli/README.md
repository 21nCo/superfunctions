# @secfn/cli

Command-line tools for SecFn.

```bash
secfn scan
secfn scan --path .
secfn scan --staged
secfn scan --git-history --commits 100
secfn scan --format table|json|sarif
secfn scan --fail-on high
secfn scan --baseline secfn-baseline.json

secfn env pull --endpoint https://app.example.com/secfn --api-key "$SECFN_TOKEN" --set production
secfn env run --endpoint https://app.example.com/secfn --api-key "$SECFN_TOKEN" --set production -- npm run build
```

The scanner uses the default SecFn secret rule pack and reporter interfaces from `@secfn/core`. Supply-chain and bad-code checks should be added as future rule packs using the same extension model.
