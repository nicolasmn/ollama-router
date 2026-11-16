# TODO

- [x] Add Wake-on-LAN support for offline nodes. MAC discovery, manual dashboard wake, and automatic wake-and-wait routing are implemented; waking requires a known MAC and WoL-capable hardware.
- [ ] Mark all in-flight requests as failed or aborted when their node drops offline. Individual upstream errors already finish requests, but marking a node unreachable does not terminate its other requests. Probes deliberately keep busy nodes reachable, so requests can remain active until a connection error or timeout.
- [ ] Verify whether upstream Ollama supports hard cancellation of running inference. Manual termination aborts the router's upstream HTTP request, but stopping inference computation inside Ollama remains unverified.
- [x] Persist local per-model latency, TPS, request counts, failures, and known nodes between restarts. Cloud metrics are excluded.
- [ ] Preserve saved model metrics when a node is offline at startup. Restoration currently requires the model to be rediscovered during startup.
- [ ] Filter recent requests by running, waiting, or failed using the existing badges. Badges currently show counts only; the list supports pagination but not status filtering.
