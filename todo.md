# Engineering Improvements (From Code Review)

- [ ] **Refactor AcpRuntime**: Convert volatile closure-based logic into a deterministic State Machine (STARTING, READY, PROMPTING).
    - [ ] Define `AcpState` enum: `IDLE`, `STARTING`, `READY`, `PROMPTING`, `ERROR`, `SHUTTING_DOWN`.
    - [ ] Create `AcpStateMachine` class to encapsulate state transitions, process management, and connection handling.
    - [ ] Implement strictly guarded transition methods (e.g., `start()`, `prompt()`, `reset()`, `shutdown()`) that prevent race conditions.
    - [ ] Migrate `acpConnection`, `agentProcess`, and `acpSessionId` into class properties managed by the state machine.
    - [ ] Verify by running `AgentManager` tests and manual CLI prompt tests.
- [ ] **Unified ContextService**: Create a dedicated service for context window management (token budgeting, priority pruning) instead of string concatenation.
    - [ ] Create `core/services/ContextService.ts` to manage the conversation context window.
    - [ ] Implement token estimation logic (e.g., Tiktoken or simple heuristic) to calculate budget.
    - [ ] Implement priority-based pruning: keep system instructions and recent user turns, summarize or drop older turns.
    - [ ] Replace manual string concatenation in `AgentManager` and `MessagingManager` with `ContextService.getPrompt()`.
    - [ ] Add unit tests for budget overflow and pruning correctness.
- [ ] **Service Registry Pattern**: Decouple `ClawlessApp` by implementing a Service Registry to replace manual getter injection.
    - [ ] Define `ServiceRegistry` interface and implementation in `core/registry/`.
    - [ ] Update `ClawlessApp` to initialize and register services (Agent, Messaging, Scheduler, Callback, Context).
    - [ ] Replace direct property access and manual dependency threading with `registry.get<T>(serviceName)`.
    - [ ] Enable easier mocking in tests by allowing registry injection.
    - [ ] Refactor `ClawlessApp.ts` to reduce its line count and responsibility.
