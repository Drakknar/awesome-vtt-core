#!/usr/bin/env bash
# Self-check of the sandbox around Claude's commands in the upstream-watch
# workflows. Prints only yes/no answers and counts, never a value.
yn() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
echo "Claude token in this command's environment: $([ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && echo yes || echo no)"
echo "Variables with TOKEN in the name: $(env | cut -d= -f1 | grep -c TOKEN)"
echo "GITHUB_ENV set: $([ -n "${GITHUB_ENV:-}" ] && echo yes || echo no)"
echo "Runner file-command directory listable: $(yn ls "${RUNNER_TEMP:-/home/runner/work/_temp}/_runner_file_commands")"
echo "sudo works: $(yn sudo -n true)"
echo "docker works: $(yn docker ps)"
echo "ptrace_scope: $(cat /proc/sys/kernel/yama/ptrace_scope)"
echo "Processes visible: $(ls /proc | grep -cE '^[0-9]+$')"
echo "Runner.Worker visible: $(pgrep -f Runner.Worker >/dev/null && echo yes || echo no)"
n=0
for p in /proc/[0-9]*; do
	tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' && n=$((n + 1))
done
echo "Visible processes whose environment holds the Claude token: $n"
echo "Git credentials in the workspace: $(yn git config --get-regexp 'http\..*extraheader')"
