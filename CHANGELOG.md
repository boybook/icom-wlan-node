# Changelog

## 0.8.1 — 2026-11-03

- Route CW text/stop acknowledgements through the same transaction owner as
  other device writes. A CW ACK timeout now cancels queued commands and retires
  the uncertain stream before another write can receive a stale acknowledgement.
- Preserve CW chunk context while exposing device NAK as a structured rejection.
- Add a UDP-peer regression for CW timeout followed by a queued PTT write.

## 0.8.0 — 2026-11-03

- Add an independent IC-7300MK2 profile with B6 identity and documented USB,
  ACC and LAN connector mappings. Use exact normalized model aliases and
  clear guessed profiles when the authoritative CI-V identity is unknown.
- Correct IC-705 USB AF output and connector input encodings.
- Bound and cancel the entire handshake, wait for UDP binding, reject failed
  authentication promptly, and release tokens/sockets/timers after partial
  connection failure. Explicit disconnect cancels automatic reconnect backoff.
- Handle control-stream single/range retransmission, bound retransmit history,
  reorder tracked packets and request missing sequences. Validate peer/session
  identity and packet lengths before refreshing connection health.
- Serialize CI-V transactions and report NAK separately from timeout. A write
  timeout cancels queued commands and retires the uncertain session.
- Bound spectrum observation by a shared deadline, reject incomplete scope
  assemblies, and avoid audio timer leaks or catch-up bursts after suspension.
- Expose bounded lifecycle logging and a complete CI-V power command API.

### Migration

All public device setters now return promises and must be awaited, including
setters that previously returned `void`. Success means an acknowledgement was
received; callers must handle rejection. Ordinary read timeouts still return
`null`. Concurrent distinct reads are serialized; identical requests remain
deduplicated. PTT no longer starts a hidden meter poller: applications schedule
their own observations.

Constructors no longer open sockets. Low-level `Session.open()` and
`UdpClient.open()` callers must await binding. `connect()` accepts a timeout
and AbortSignal. `WLAN` retains its network-input API meaning and maps to LAN
on MK2; combined input modes are represented by `MIC_USB` and `MIC_ACC` where
supported.

Validation uses production protocol owners against an in-memory UDP peer and
packet fixtures. Physical IC-705/IC-7300MK2 firmware validation is still required.
