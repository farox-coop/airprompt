.PHONY: setup cert start stop clean refresh logs lint test-unit test-integration test-all install-plugin uninstall-plugin

LOG_FILE := /tmp/airprompt.log
PID_FILE := /tmp/airprompt-server.pid

setup:
	@npm install
	@$(MAKE) cert

cert:
	@bash bin/generate-cert.sh

start:
	@nohup node server.js > $(LOG_FILE) 2>&1 &
	@for i in $$(seq 1 20); do \
	  if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE) 2>/dev/null) 2>/dev/null; then break; fi; \
	  sleep 0.5; \
	done
	@echo "AirPrompt started (PID $$(cat $(PID_FILE) 2>/dev/null))"
	@echo "Logs: $(LOG_FILE)"
	@tail -5 $(LOG_FILE) 2>/dev/null || true

stop:
	@kill $$(cat $(PID_FILE) 2>/dev/null) 2>/dev/null || true
	@rm -f $(PID_FILE)

clean:
	@rm -f $(PID_FILE) $(LOG_FILE)
	@rm -rf node_modules

refresh: stop clean setup start

logs:
	@tail -f $(LOG_FILE)

lint:
	@node --check server.js
	@node --check public/client.js
	@node --check bin/install.js
	@node --check bin/lib/settings.js

test-unit:
	@node --test test/unit/*.test.js
	@bash test/unit/statusline.test.sh
	@bash test/unit/sync.test.sh

test-integration:
	@bash test/integration/run.sh

test-all: test-unit test-integration

install-plugin:
	@node bin/install.js

uninstall-plugin:
	@node bin/install.js --uninstall
