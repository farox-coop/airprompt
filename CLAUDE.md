# AirPrompt

## Entrypoint

ALL AirPrompt commands go through `bin/airprompt` dispatcher. NEVER call sub-scripts directly.

```
bin/airprompt on [<name>]   # start daemon + register (optional name)
bin/airprompt off           # unregister + stop
bin/airprompt status        # show status
bin/airprompt name <s>      # name/rename session
bin/airprompt clean         # full teardown
bin/airprompt help          # show usage
```

## Development

- Always `AIRPROMPT_DEBUG=1` when running scripts in dev. Use: `AIRPROMPT_DEBUG=1 bin/airprompt <cmd>`
- Run tests: `make test-all`
