## Summary

What does this change and why?

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Docs / governance
- [ ] Test / CI
- [ ] Refactor (no behavior change)

## Checklist

- [ ] `make test-all` passes locally
- [ ] `make agnostic-check` passes (no hardcoded provider names in core code)
- [ ] No hardcoded user paths — use `$HOME` / `os.homedir()` / `$CLAUDE_CONFIG_DIR`
- [ ] If this adds a provider: it lives in `src/providers/<name>.js` only, and `test/unit/provider-interface.test.js` passes without edits
- [ ] Docs (`README.md`, `docs/`, `CONTRIBUTING.md`) updated if behavior changed

## Test plan

How did you verify this? Include commands and any manual checks.
