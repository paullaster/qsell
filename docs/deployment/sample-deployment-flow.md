 Now can You give me a well document end to end deployment flow for this application for every new server I will have. the user name  ip and any server related values or variable will always vary do make it very decoupled from specific server or values. very configurable.

I'll build this as parameterised scripts plus a rewritten runbook, so every server is driven by one small config file instead of hand-edited commands. I'll start by reading what exists so I extend it rather than duplicate it.

  Ran 6 shell commands

I've written the shared config library, the config template and the instance provisioning script. Next is the Nginx/TLS script and the GitHub setup script, then I'll test what I can locally.

  Ran 2 shell commands

Tests passed for validation, idempotency, and the Nginx dry-run, but I found an apostrophe in a heredoc default inside provision-instance.sh that's breaking substitution—fixing it now. · summary

  Ran 2 shell commands

The scripts work in testing. The one thing I couldn't exercise end to end is the real GitHub write, since the dry-run stops before any gh call. Now the runbook itself.

  Ran 3 shell commands

I've rewritten DEPLOYMENT.md as an end-to-end runbook and added scripts so each new server is driven by one config file. I tested the scripts locally, but I haven't run them on a real server or against GitHub (see "Not verified" below). Nothing is committed.