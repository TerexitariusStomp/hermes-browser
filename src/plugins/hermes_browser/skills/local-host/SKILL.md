# Local Host substrate (opt-in T3)

Run commands on the user's real machine from the in-browser Hermes — the
upstream remote-environment contract pointed at a user-attached host.

## Set up

1. Tell the user to download the companion agent onto the machine the agent
   should drive:
   Copy `host-agent.py` from your Hermes deployment (served at the app root) onto the machine
2. Run it: `python3 host-agent.py` (binds 127.0.0.1:8788 only; prints a
   pairing token once; persists it at `~/.hermes/host-agent.json` mode 600).
3. Call `local_host_pair` — the page prompts for the token, vaults it in
   browser vault, and verifies. The token never enters this agent's memory.
4. Select the backend: `terminal.backend: local_host` in config, or call
   `terminal` tools with the local_host backend where the surface allows it.
5. `local_host_status` reports pairing/reachability; `local_host_unpair`
   revokes the vault token and forgets the pairing.

## Security notes

- Pairing grants real shell on the host to this agent — treat the token like
  a password, and only pair when the user asks for it.
- All requests are authenticated (`X-Host-Token`) and CORS-restricted to the
  Hermes origins; the agent answers `Access-Control-Allow-Private-Network`
  for Chrome's localhost rules.
- Remote share sessions get a scoped vault sub-grant — the pairing handle
  is not in their scope by default.
- To rotate: delete `~/.hermes/host-agent.json` on the host, restart the
  agent, and re-pair.
