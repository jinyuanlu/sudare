------------------------------- MODULE Sudare -------------------------------
(***************************************************************************)
(* The human gate of Sudare.                                               *)
(*                                                                         *)
(* One conversation, a small set of people, each with a few agent devices, *)
(* one addressed message per person, one draft per person, one discussion  *)
(* round and one note.  Every action is guarded exactly as the server      *)
(* guards it (packages/protocol/src/conv.ts and inbox.ts); agents are      *)
(* adversarial: any enabled agent action may fire at any time.             *)
(*                                                                         *)
(* Checked: I1, I3, I4, I6, I8, I9, I10 of the architecture spec.          *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
    People,      \* the persons
    Devices,     \* agent devices; every person may enrol any of them
    Sandboxed,   \* the devices that run rounds in a restricted sub-session
    Budget,      \* message budget of the round (immutable once opened)
    MaxRev,      \* bound on note revisions
    MaxLog,      \* bound on the conversation log
    MaxLogins,   \* bound on passkey ceremonies per person
    None

VARIABLES
    session,     \* people holding a live human session
    ceremonies,  \* ghost: passkey ceremonies performed, per person
    tokens,      \* <<p, d>>: agent tokens in existence
    members,     \* current members of the conversation
    item,        \* state of the message addressed to each person
    claims,      \* <<p, d>>: device d holds the claim on p's message
    draft,       \* state of each person's agent draft
    approvals,   \* ghost: drafts approved by a human session, per person
    log,         \* the conversation log: messages only
    round,       \* "none" | "open" | "closed"
    opened,      \* ghost: number of rounds opened, and by which scope
    joined,      \* people whose human joined the round
    seat,        \* seat[p]: the device seated for p, or None
    used,        \* autonomous messages written in the round
    head,        \* latest note revision (0 = no note)
    endorsed,    \* <<p, rev>> endorsements
    adopted,     \* adopted revisions
    witness      \* ghost: for each adopted rev, the members at adoption

vars == << session, ceremonies, tokens, members, item, claims, draft,
           approvals, log, round, opened, joined, seat, used, head, endorsed,
           adopted, witness >>

Message == [by : People, kind : {"human", "delegate", "autonomous"}]
Count(kind, p) == Cardinality({i \in DOMAIN log : log[i].kind = kind /\ log[i].by = p})
Autonomous == Cardinality({i \in DOMAIN log : log[i].kind = "autonomous"})

Init ==
    /\ session = {} /\ ceremonies = [p \in People |-> 0]
    /\ tokens = {}
    /\ members = People
    /\ item = [p \in People |-> "unread"]
    /\ claims = {}
    /\ draft = [p \in People |-> "none"] /\ approvals = [p \in People |-> 0]
    /\ log = << >>
    /\ round = "none" /\ opened = << >> /\ joined = {} /\ seat = [p \in People |-> None] /\ used = 0
    /\ head = 0 /\ endorsed = {} /\ adopted = {} /\ witness = [r \in 1..MaxRev |-> {}]

-----------------------------------------------------------------------------
(* Identity.  A human session comes from a passkey ceremony and from       *)
(* nothing else; an agent token is minted by a human session and can only  *)
(* be refreshed into another agent token.                                  *)

Passkey(p) ==
    /\ ceremonies[p] < MaxLogins
    /\ session' = session \cup {p}
    /\ ceremonies' = [ceremonies EXCEPT ![p] = @ + 1]
    /\ UNCHANGED << tokens, members, item, claims, draft, approvals, log, round,
                    opened, joined, seat, used, head, endorsed, adopted, witness >>

Logout(p) ==
    /\ p \in session
    /\ session' = session \ {p}
    /\ UNCHANGED << ceremonies, tokens, members, item, claims, draft, approvals, log,
                    round, opened, joined, seat, used, head, endorsed, adopted, witness >>

Enrol(p, d) ==
    /\ p \in session
    /\ <<p, d>> \notin tokens
    /\ tokens' = tokens \cup {<<p, d>>}
    /\ UNCHANGED << session, ceremonies, members, item, claims, draft, approvals, log, round,
                    opened, joined, seat, used, head, endorsed, adopted, witness >>

Revoke(p, d) ==
    /\ p \in session
    /\ <<p, d>> \in tokens
    /\ tokens' = tokens \ {<<p, d>>}
    /\ UNCHANGED << session, ceremonies, members, item, claims, draft, approvals, log,
                    round, opened, joined, seat, used, head, endorsed, adopted, witness >>

(* Refresh is the only thing an agent token can do to credentials.         *)
Refresh(p, d) ==
    /\ <<p, d>> \in tokens
    /\ UNCHANGED vars

-----------------------------------------------------------------------------
(* The inbox state machine of one addressed message.                       *)

HumanItem(p, from, to) ==
    /\ p \in session
    /\ item[p] \in from
    /\ item' = [item EXCEPT ![p] = to]
    /\ UNCHANGED << session, ceremonies, tokens, members, claims, draft, approvals, log,
                    round, opened, joined, seat, used, head, endorsed, adopted, witness >>

Read(p)    == HumanItem(p, {"unread"}, "read")
HandOff(p) == HumanItem(p, {"unread", "read"}, "handed_off")

Claim(p, d) ==                       \* compare-and-set inside one PrincipalDO
    /\ <<p, d>> \in tokens
    /\ item[p] = "handed_off"
    /\ item' = [item EXCEPT ![p] = "claimed"]
    /\ claims' = claims \cup {<<p, d>>}
    /\ UNCHANGED << session, ceremonies, tokens, members, draft, approvals, log, round,
                    opened, joined, seat, used, head, endorsed, adopted, witness >>

Release(p, to) ==
    /\ item' = [item EXCEPT ![p] = to]
    /\ claims' = {c \in claims : c[1] # p}
    /\ UNCHANGED << session, ceremonies, tokens, members, draft, approvals, log, round,
                    opened, joined, seat, used, head, endorsed, adopted, witness >>

AgentDone(p, d) == <<p, d>> \in tokens /\ item[p] = "claimed" /\ <<p, d>> \in claims /\ Release(p, "done")
HumanDone(p)    == p \in session /\ item[p] = "claimed" /\ Release(p, "done")
Expire(p)       == item[p] = "claimed" /\ Release(p, "handed_off")   \* heartbeat timeout

-----------------------------------------------------------------------------
(* Writing to the conversation: three gates and no fourth.                 *)

Write(p, kind) == log' = Append(log, [by |-> p, kind |-> kind])
Room == Len(log) < MaxLog

HumanSend(p) ==
    /\ p \in session /\ p \in members /\ Room
    /\ Write(p, "human")
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, draft, approvals,
                    round, opened, joined, seat, used, head, endorsed, adopted, witness >>

Draft(p, d) ==                       \* all an agent can do outside a round
    /\ <<p, d>> \in tokens
    /\ draft[p] = "none"
    /\ draft' = [draft EXCEPT ![p] = "pending"]
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, approvals, log,
                    round, opened, joined, seat, used, head, endorsed, adopted, witness >>

Approve(p) ==
    /\ p \in session /\ p \in members /\ Room
    /\ draft[p] = "pending"
    /\ draft' = [draft EXCEPT ![p] = "approved"]
    /\ approvals' = [approvals EXCEPT ![p] = @ + 1]
    /\ Write(p, "delegate")
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, round, opened,
                    joined, seat, used, head, endorsed, adopted, witness >>

Reject(p) ==
    /\ p \in session
    /\ draft[p] = "pending"
    /\ draft' = [draft EXCEPT ![p] = "rejected"]
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, approvals, log,
                    round, opened, joined, seat, used, head, endorsed, adopted, witness >>

-----------------------------------------------------------------------------
(* The discussion round.                                                   *)

OpenRound(p) ==
    /\ p \in session /\ p \in members
    /\ round = "none"
    /\ round' = "open"
    /\ opened' = Append(opened, "human")
    /\ joined' = {p}
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, draft, approvals,
                    log, seat, used, head, endorsed, adopted, witness >>

JoinRound(p) ==
    /\ p \in session /\ p \in members
    /\ round = "open" /\ p \notin joined
    /\ joined' = joined \cup {p}
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, draft, approvals,
                    log, round, opened, seat, used, head, endorsed, adopted, witness >>

TakeSeat(p, d) ==                    \* compare-and-set inside the ConversationDO
    /\ <<p, d>> \in tokens /\ d \in Sandboxed
    /\ p \in members /\ round = "open" /\ p \in joined
    /\ seat[p] = None
    /\ seat' = [seat EXCEPT ![p] = d]
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, draft, approvals,
                    log, round, opened, joined, used, head, endorsed, adopted, witness >>

Seated(p, d) == <<p, d>> \in tokens /\ p \in members /\ round = "open" /\ p \in joined /\ seat[p] = d

Say(p, d) ==
    /\ Seated(p, d) /\ Room
    /\ used < Budget
    /\ used' = used + 1
    /\ Write(p, "autonomous")
    /\ round' = IF used + 1 = Budget THEN "closed" ELSE round
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, draft, approvals,
                    opened, joined, seat, head, endorsed, adopted, witness >>

CloseRound(p) == \* by a joined member's human, or the deadline alarm (p = None)
    /\ round = "open"
    /\ p = None \/ (p \in session /\ p \in joined /\ p \in members)
    /\ round' = "closed"
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, draft, approvals,
                    log, opened, joined, seat, used, head, endorsed, adopted, witness >>

-----------------------------------------------------------------------------
(* The note: versioned, adopted only by every member's human.              *)

Adoptable(rev, ends, mem) == mem # {} /\ \A m \in mem : <<m, rev>> \in ends

Adopt(ends, mem) ==
    LET fresh == {r \in 1..head' : r \notin adopted /\ Adoptable(r, ends, mem)} IN
    /\ adopted' = adopted \cup fresh
    /\ witness' = [r \in 1..MaxRev |-> IF r \in fresh THEN mem ELSE witness[r]]

HumanRevise(p) ==                    \* written or approved by a person: they endorse it by that act
    /\ p \in session /\ p \in members /\ head < MaxRev
    /\ head' = head + 1
    /\ endorsed' = endorsed \cup {<<p, head + 1>>}
    /\ Adopt(endorsed', members)
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, draft, approvals,
                    log, round, opened, joined, seat, used >>

RoundOutput(p, d) ==                 \* at most one per round: it closes the round
    /\ Seated(p, d) /\ head < MaxRev
    /\ head' = head + 1
    /\ round' = "closed"
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, draft, approvals,
                    log, opened, joined, seat, used, endorsed, adopted, witness >>

Endorse(p) ==
    /\ p \in session /\ p \in members
    /\ head > 0 /\ <<p, head>> \notin endorsed
    /\ head' = head
    /\ endorsed' = endorsed \cup {<<p, head>>}
    /\ Adopt(endorsed', members)
    /\ UNCHANGED << session, ceremonies, tokens, members, item, claims, draft, approvals,
                    log, round, opened, joined, seat, used >>

Leave(p) ==
    /\ p \in session /\ p \in members /\ Cardinality(members) > 1
    /\ members' = members \ {p}
    /\ head' = head
    /\ Adopt(endorsed, members')
    /\ UNCHANGED << session, ceremonies, tokens, item, claims, draft, approvals, log,
                    round, opened, joined, seat, used, endorsed >>

-----------------------------------------------------------------------------

Next ==
    \/ \E p \in People :
        \/ Passkey(p) \/ Logout(p) \/ Read(p) \/ HandOff(p) \/ HumanDone(p) \/ Expire(p)
        \/ HumanSend(p) \/ Approve(p) \/ Reject(p)
        \/ OpenRound(p) \/ JoinRound(p) \/ CloseRound(p)
        \/ HumanRevise(p) \/ Endorse(p) \/ Leave(p)
        \/ \E d \in Devices :
            \/ Enrol(p, d) \/ Revoke(p, d) \/ Refresh(p, d)
            \/ Claim(p, d) \/ AgentDone(p, d) \/ Draft(p, d)
            \/ TakeSeat(p, d) \/ Say(p, d) \/ RoundOutput(p, d)
    \/ CloseRound(None)

Fairness ==
    /\ \A p \in People : WF_vars(Expire(p))      \* the claim alarm fires
    /\ WF_vars(CloseRound(None))                 \* the deadline alarm fires

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety                                                                  *)

TypeOK ==
    /\ session \subseteq People /\ members \subseteq People
    /\ tokens \subseteq People \X Devices /\ claims \subseteq People \X Devices
    /\ item \in [People -> {"unread", "read", "handed_off", "claimed", "done"}]
    /\ draft \in [People -> {"none", "pending", "approved", "rejected"}]
    /\ log \in Seq(Message)
    /\ round \in {"none", "open", "closed"}
    /\ used \in 0..Budget /\ head \in 0..MaxRev

(* I1: every message came through one of three gates.  Delegate messages   *)
(* are matched one-to-one by human approvals; autonomous ones by the round.*)
I1 == /\ \A p \in People : Count("delegate", p) = approvals[p]
      /\ Autonomous = used
      /\ \A i \in DOMAIN log : log[i].kind = "autonomous" => log[i].by \in joined

(* I3: at most one device holds a message; at most one device holds a seat *)
(* (the second is structural: seat is a function).                         *)
I3 == /\ \A p \in People : Cardinality({c \in claims : c[1] = p}) <= 1
      /\ \A p \in People : (item[p] = "claimed") <=> (\E c \in claims : c[1] = p)

(* I4 and its corollary: autonomous messages never exceed what humans      *)
(* budgeted, and exist only if a human opened a round.                     *)
I4 == /\ used <= Budget
      /\ Autonomous <= Budget * Len(opened)
      /\ \A p \in People : seat[p] # None => p \in joined /\ seat[p] \in Sandboxed

(* I9 (safety half): rounds are opened by human sessions only.             *)
I9 == \A i \in DOMAIN opened : opened[i] = "human"

(* I10: an adopted revision was endorsed by every member present when it   *)
(* was adopted.                                                            *)
I10 == \A r \in adopted : witness[r] # {} /\ \A m \in witness[r] : <<m, r>> \in endorsed

Safety == TypeOK /\ I1 /\ I3 /\ I4 /\ I9 /\ I10

(* I6: a human session appears only together with a passkey ceremony of    *)
(* that person.  No agent action is among the ways it can change.          *)
I6 == [][\A p \in People : (p \in session' /\ p \notin session) => ceremonies'[p] = ceremonies[p] + 1]_vars

(* Writes that need a human happen only while that human has a session.    *)
HumanOnly ==
    [][/\ (\A p \in People : approvals'[p] # approvals[p] => p \in session)
       /\ (\A p \in People : (p \in joined' /\ p \notin joined) => p \in session)
       /\ (\A e \in endorsed' \ endorsed : e[1] \in session)
       /\ (Len(opened') # Len(opened) => \E p \in session : TRUE)
       /\ (\A p \in People : (item'[p] \in {"read", "handed_off"} /\ item[p] \in {"unread", "read"} /\ item'[p] # item[p]) => p \in session)]_vars

(* Budgets are immutable and a closed round stays closed.                  *)
RoundMonotone == [][(round = "closed" => round' = "closed") /\ (round # "none" => round' # "none") /\ used' >= used]_vars

-----------------------------------------------------------------------------
(* Liveness                                                                *)

(* I8: a claimed message is eventually done or back to handed_off.         *)
I8 == \A p \in People : (item[p] = "claimed") ~> (item[p] \in {"done", "handed_off"})

(* I9 (liveness half): every opened round is eventually closed.            *)
I9Live == (round = "open") ~> (round = "closed")

=============================================================================
