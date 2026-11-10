# The gate, as a TLA+ model

`Sudare.tla` models what must never go wrong, at the level of the server's guards: who
holds which credential, the inbox state machine of an addressed message, the three ways a
message can enter a conversation, the discussion round and its budget, and the note with
its endorsements. Agents are adversarial: any agent action whose guard holds may fire at
any time.

| Property | In the model |
| --- | --- |
| I1 | `I1`: delegate messages equal human approvals; autonomous messages equal the round's counter and come only from joined members |
| I3 | `I3`: at most one claim per message; `seat` is a function, set once (`TakeSeat` requires `None`) |
| I4 | `I4`: `used <= Budget`; autonomous messages bounded by `Budget * rounds opened`; a seat implies a human join and a sandboxed device |
| I6 | `I6`: a session appears only together with a passkey ceremony; `HumanOnly`: approvals, joins, endorsements, handoffs happen only under a session |
| I8 | `I8`: `claimed ~> done or handed_off`, under weak fairness of the expiry alarm |
| I9 | `I9` and `RoundMonotone` (safety), `I9Live`: `open ~> closed`, under weak fairness of the deadline alarm |
| I10 | `I10`: every adopted revision was endorsed by every member present at adoption (`witness`) |

The full product of the sub-machines is large and they interact only through sessions,
tokens and membership, so there are four configurations (`Sudare.inbox.cfg`, `.gates`,
`.round`, `.note`), each exploring one sub-machine with the others held at rest.

Run them (Java 11+; downloads `tla2tools.jar` on first use):

```bash
sh spec/check.sh
```

The guards here mirror `decide` in `packages/protocol/src/conv.ts` and `transition` in
`packages/protocol/src/inbox.ts`. The property tests in `packages/protocol/test` check the
same invariants on the real code with randomly generated command sequences; the model
checks them exhaustively on a small world. When a guard changes in one place, change it in
the other.
