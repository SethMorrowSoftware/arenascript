// ============================================================================
// ArenaScript Semantic Analyzer — Type checking, scope resolution, validation
// ============================================================================

const VALID_EVENTS = new Set([
  "spawn", "tick", "damaged", "enemy_seen", "enemy_lost",
  "cooldown_ready", "low_health", "destroyed",
  "signal_received",
]);

const BUILTIN_SENSORS = new Set([
  "health", "max_health", "energy", "position", "velocity", "heading", "cooldown",
  "nearest_enemy", "visible_enemies", "enemy_count_in_range",
  "nearest_ally", "visible_allies",
  "nearest_cover", "nearest_resource", "nearest_control_point",
  "nearest_enemy_control_point", "nearest_heal_zone", "nearest_hazard",
  "distance_to", "line_of_sight", "current_tick",
  "can_attack", "scan", "scan_enemies", "last_seen_enemy", "has_recent_enemy_contact",
  "enemy_visible", "random", "wall_ahead", "damage_percent",
  "team_size", "my_index", "my_role",
  "is_in_heal_zone", "is_in_hazard",
  "arena_width", "arena_height", "spawn_position",
  "discovered_count",
  // New perception sensors
  "health_percent", "angle_to", "is_facing", "enemy_heading",
  "is_enemy_facing_me", "ally_health", "kills", "time_alive",
  // Noise & signals
  "nearest_sound",
  // Mines & pickups
  "nearest_mine", "nearest_pickup",
  // Waypoint memory
  "recall_position",
  // State queries
  "is_taunted", "is_in_overwatch", "has_effect",
  // Resource economy
  "heat", "max_heat", "heat_percent", "overheated",
  "ammo", "max_ammo", "ammo_percent",
  // Cloak + shield + self-destruct state
  "is_cloaked", "cloak_remaining",
  "is_shielded", "shield_remaining",
  "self_destruct_armed", "self_destruct_remaining",
  // Resupply depots
  "nearest_depot", "is_on_depot",
  // Hive (shared team memory)
  "hive_get", "hive_set", "hive_has",
  // Math built-ins
  "abs", "min", "max", "clamp", "floor", "ceil", "round", "sign",
  "sqrt", "pow", "lerp", "pi",
  // Extended math (trig + angles) — useful for trajectory prediction
  "sin", "cos", "atan2", "deg_to_rad", "rad_to_deg",
  // Vector / spatial helpers
  "distance_between", "direction_to", "angle_between", "make_position",
  // Team / tactics helpers
  "squad_center", "lowest_health_ally", "weakest_visible_enemy",
  "count_enemies_near", "count_allies_near",
  // Timing helper
  "tick_phase",
  // List helpers
  "length", "list_empty",
  // Predictive perception (NEW)
  "enemy_velocity", "predict_position", "incoming_projectile",
  "damage_direction", "last_damage_tick", "threat_level",
  // Debug / introspection
  "log",
  // List stdlib
  "list_contains", "list_first", "list_last", "list_sum", "index_of",
  // String stdlib
  "string_contains", "starts_with", "ends_with",
  // Extended random
  "rand_float", "chance",
  // Extended vector math
  "hypot", "mod", "dot", "normalize", "vec_add", "vec_scale",
]);

const VALID_ACTIONS = new Set([
  "move_to", "move_toward", "strafe_left", "strafe_right", "stop",
  "attack", "fire_at", "shield", "retreat",
  "burst_fire", "grenade",
  "move_forward", "move_backward", "turn_left", "turn_right",
  "place_mine", "send_signal", "mark_position", "taunt", "overwatch",
  // Resource economy + advanced combat
  "fire_light", "fire_heavy", "zap", "vent_heat",
  "cloak", "self_destruct",
]);

const VALID_TYPES = new Set([
  "number", "boolean", "string", "id", "vector", "direction",
  "robot_ref", "enemy", "ally", "projectile", "resource_node",
  "control_point", "event", "position", "list",
]);

/** Find the closest match from a set of candidates using Levenshtein distance */
/**
 * If `expr` is a literal of a known type, return the type name. Returns
 * null for non-literals (we can't infer arbitrary expression types).
 */
function literalType(expr) {
  if (!expr) return null;
  if (expr.kind === "NumberLiteral") return "number";
  if (expr.kind === "StringLiteral") return "string";
  if (expr.kind === "BooleanLiteral") return "boolean";
  if (expr.kind === "NullLiteral") return null; // null matches anything nullable
  return null;
}

function findClosestMatch(name, candidates, maxDistance = 3) {
  let best = null;
  let bestDist = maxDistance + 1;
  for (const candidate of candidates) {
    const dist = levenshtein(name.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[b.length][a.length];
}

export class SemanticAnalyzer {
  #diagnostics = [];
  #constants = new Set();
  #stateVars = new Set();
  #functions = new Map();
  #localScopes = [];
  // Tracks usage + declaration span of state vars and constants so we can
  // surface "declared but never used" warnings at the end of analysis.
  #stateMeta = new Map(); // name -> { used:boolean, line, column }
  #constMeta = new Map();
  #loopDepth = 0;

  #containsBreak(stmts) {
    for (const s of stmts) {
      if (!s) continue;
      if (s.kind === "BreakStatement") return true;
      if (s.kind === "IfStatement") {
        if (this.#containsBreak(s.thenBranch)) return true;
        for (const b of s.elseIfBranches) if (this.#containsBreak(b.body)) return true;
        if (s.elseBranch && this.#containsBreak(s.elseBranch)) return true;
      }
      if (s.kind === "ReturnStatement") return true;
    }
    return false;
  }

  analyze(program) {
    this.#diagnostics = [];
    this.#constants = new Set();
    this.#stateVars = new Set();
    this.#functions = new Map();
    this.#localScopes = [];
    this.#stateMeta = new Map();
    this.#constMeta = new Map();
    this.#loopDepth = 0;

    // Validate robot declaration
    if (!program.robot.name || program.robot.name.trim() === "") {
      this.#addError("Robot name cannot be empty", program.robot.span.line, program.robot.span.column);
    }
    if (!program.robot.version) {
      this.#addError("Robot version is required", program.robot.span.line, program.robot.span.column);
    }

    // Validate meta
    if (program.meta) {
      for (const entry of program.meta.entries) {
        if (entry.key === "class") {
          const validClasses = ["brawler", "ranger", "tank", "support"];
          if (!validClasses.includes(entry.value)) {
            this.#addWarning(
              `Unknown robot class '${entry.value}'. Valid: ${validClasses.join(", ")}`,
              program.meta.span.line, program.meta.span.column,
            );
          }
        }
      }
    }

    // Validate squad composition
    if (program.squad) {
      const { size, roles, span } = program.squad;
      if (size !== undefined) {
        const parsedSize = Number(size);
        if (!Number.isInteger(parsedSize) || parsedSize < 1 || parsedSize > 5) {
          this.#addError("squad.size must be an integer from 1 to 5", span.line, span.column);
        }
      }
      if (roles) {
        if (!Array.isArray(roles) || roles.length === 0) {
          this.#addError("squad.roles must contain at least one role string", span.line, span.column);
        }
        const normalized = new Set();
        for (const role of roles) {
          if (!role || role.trim() === "") {
            this.#addError("squad.roles cannot include empty strings", span.line, span.column);
          }
          if (normalized.has(role)) {
            this.#addWarning(`Duplicate squad role '${role}'`, span.line, span.column);
          }
          normalized.add(role);
        }
        if (size !== undefined && roles.length > Number(size)) {
          this.#addError("squad.roles length cannot exceed squad.size", span.line, span.column);
        }
      }
    }

    // Register constants
    if (program.constants) {
      for (const entry of program.constants.entries) {
        if (this.#constants.has(entry.name)) {
          this.#addError(`Duplicate constant '${entry.name}'`, entry.span.line, entry.span.column);
        }
        this.#constants.add(entry.name);
        this.#constMeta.set(entry.name, { used: false, line: entry.span.line, column: entry.span.column });
      }
    }

    // Register state variables
    if (program.state) {
      for (const entry of program.state.entries) {
        if (this.#stateVars.has(entry.name) || this.#constants.has(entry.name)) {
          this.#addError(`Duplicate state variable '${entry.name}'`, entry.span.line, entry.span.column);
        }
        this.#validateType(entry.type);
        const declaredType = entry.type?.name ?? null;
        // Initializer must match declared type (when both are known literals).
        if (entry.initialValue) {
          const litType = literalType(entry.initialValue);
          if (litType && declaredType && litType !== declaredType) {
            this.#addError(
              `Type mismatch: state '${entry.name}' is declared as ${declaredType} but initialized with a ${litType} literal`,
              entry.span.line, entry.span.column,
            );
          }
        }
        this.#stateVars.add(entry.name);
        this.#stateMeta.set(entry.name, {
          used: false,
          line: entry.span.line,
          column: entry.span.column,
          type: declaredType,
        });
      }
    }

    // Register functions (first pass for forward references)
    for (const fn of program.functions) {
      if (this.#functions.has(fn.name) || BUILTIN_SENSORS.has(fn.name)) {
        this.#addError(`Duplicate or conflicting function name '${fn.name}'`, fn.span.line, fn.span.column);
      }
      this.#functions.set(fn.name, fn);
    }

    // Validate event handlers
    const seenEvents = new Set();
    for (const handler of program.handlers) {
      if (!VALID_EVENTS.has(handler.event)) {
        const suggestion = findClosestMatch(handler.event, VALID_EVENTS);
        const hint = suggestion ? `. Did you mean '${suggestion}'?` : "";
        this.#addError(`Unknown event '${handler.event}'${hint}`, handler.span.line, handler.span.column);
      }
      if (seenEvents.has(handler.event)) {
        this.#addError(`Duplicate handler for event '${handler.event}'`, handler.span.line, handler.span.column);
      }
      seenEvents.add(handler.event);

      // Validate handler body
      this.#pushScope();
      if (handler.param) {
        this.#addLocal(handler.param, handler.span);
      }
      this.#validateStatements(handler.body);
      this.#popScope();
    }

    // Validate functions
    for (const fn of program.functions) {
      this.#pushScope();
      for (const param of fn.params) {
        this.#validateType(param.type);
        this.#addLocal(param.name, param.type?.span ?? fn.span);
      }
      if (fn.returnType) {
        this.#validateType(fn.returnType);
      }
      this.#validateStatements(fn.body);
      this.#popScope();
    }

    // Must have at least a tick handler
    if (!seenEvents.has("tick") && !seenEvents.has("spawn")) {
      this.#addWarning("Program has no 'tick' or 'spawn' handler", program.span.line, program.span.column);
    }

    // Unused declaration warnings — help new authors notice dead code.
    for (const [name, meta] of this.#stateMeta) {
      if (!meta.used) {
        this.#addWarning(
          `State variable '${name}' is declared but never read. Remove it or reference it with 'set' elsewhere.`,
          meta.line, meta.column,
        );
      }
    }
    for (const [name, meta] of this.#constMeta) {
      if (!meta.used) {
        this.#addWarning(
          `Constant '${name}' is declared but never used.`,
          meta.line, meta.column,
        );
      }
    }

    return this.#diagnostics;
  }

  #validateStatements(stmts) {
    for (const stmt of stmts) {
      this.#validateStatement(stmt);
    }
  }

  #validateStatement(stmt) {
    switch (stmt.kind) {
      case "LetStatement":
        this.#validateExpression(stmt.value);
        this.#addLocal(stmt.name, stmt.span);
        break;

      case "SetStatement": {
        // `set` can mutate either a state variable (persistent) or a local
        // variable declared with `let` in the enclosing scope. Locals are
        // required for mutable counters inside `while` loops, which would
        // otherwise be nearly useless.
        let isLocal = false;
        for (let i = this.#localScopes.length - 1; i >= 0; i--) {
          if (this.#localScopes[i].has(stmt.name)) { isLocal = true; break; }
        }
        if (!this.#stateVars.has(stmt.name) && !isLocal) {
          if (this.#constants.has(stmt.name)) {
            this.#addError(`Cannot mutate constant '${stmt.name}'. Constants are immutable`, stmt.span.line, stmt.span.column);
          } else if (BUILTIN_SENSORS.has(stmt.name)) {
            this.#addError(`Cannot assign to built-in sensor '${stmt.name}'`, stmt.span.line, stmt.span.column);
          } else {
            this.#addError(
              `'set' can only mutate state variables or locals. '${stmt.name}' is not declared.`,
              stmt.span.line, stmt.span.column,
            );
          }
        }
        // Literal-type check for state mutations. We can't infer types from
        // arbitrary expressions, but a literal RHS that obviously mismatches
        // the declared state type is always a bug.
        if (this.#stateMeta.has(stmt.name)) {
          const declared = this.#stateMeta.get(stmt.name).type;
          const litType = literalType(stmt.value);
          if (litType && declared && litType !== declared) {
            this.#addError(
              `Type mismatch: '${stmt.name}' is declared as ${declared} but assigned a ${litType} literal`,
              stmt.span.line, stmt.span.column,
            );
          }
        }
        this.#validateExpression(stmt.value);
        break;
      }

      case "IfStatement":
        this.#validateExpression(stmt.condition);
        this.#pushScope();
        this.#validateStatements(stmt.thenBranch);
        this.#popScope();
        for (const branch of stmt.elseIfBranches) {
          this.#validateExpression(branch.condition);
          this.#pushScope();
          this.#validateStatements(branch.body);
          this.#popScope();
        }
        if (stmt.elseBranch) {
          this.#pushScope();
          this.#validateStatements(stmt.elseBranch);
          this.#popScope();
        }
        break;

      case "ForStatement":
        this.#validateExpression(stmt.iterable);
        this.#pushScope();
        this.#addLocal(stmt.variable, stmt.span);
        this.#loopDepth++;
        this.#validateStatements(stmt.body);
        this.#loopDepth--;
        this.#popScope();
        break;

      case "WhileStatement":
        this.#validateExpression(stmt.condition);
        // Detect obvious `while true` with no break inside, which would hang
        // the tick budget. We still allow it (break can exit) but warn.
        if (stmt.condition.kind === "BooleanLiteral" && stmt.condition.value === true) {
          if (!this.#containsBreak(stmt.body)) {
            this.#addWarning(
              "`while true` with no `break` will burn the tick budget every tick.",
              stmt.span.line, stmt.span.column,
            );
          }
        }
        this.#pushScope();
        this.#loopDepth++;
        this.#validateStatements(stmt.body);
        this.#loopDepth--;
        this.#popScope();
        break;

      case "BreakStatement":
        if (this.#loopDepth === 0) {
          this.#addError("'break' is only allowed inside a loop.", stmt.span.line, stmt.span.column);
        }
        break;

      case "ContinueStatement":
        if (this.#loopDepth === 0) {
          this.#addError("'continue' is only allowed inside a loop.", stmt.span.line, stmt.span.column);
        }
        break;

      case "ReturnStatement":
        if (stmt.value) {
          this.#validateExpression(stmt.value);
        }
        break;

      case "ActionStatement":
        if (!VALID_ACTIONS.has(stmt.action)) {
          const suggestion = findClosestMatch(stmt.action, VALID_ACTIONS);
          const hint = suggestion ? `. Did you mean '${suggestion}'?` : "";
          this.#addError(`Unknown action '${stmt.action}'${hint}`, stmt.span.line, stmt.span.column);
        }
        for (const arg of stmt.args) {
          this.#validateExpression(arg);
        }
        break;

      case "AfterStatement":
        this.#validateExpression(stmt.delay);
        this.#pushScope();
        this.#validateStatements(stmt.body);
        this.#popScope();
        break;

      case "EveryStatement":
        this.#validateExpression(stmt.interval);
        this.#pushScope();
        this.#validateStatements(stmt.body);
        this.#popScope();
        break;

      case "ExpressionStatement":
        this.#validateExpression(stmt.expression);
        // A bare non-call expression (`42`, `enemy.position`, `x + 1`) has no
        // side effects and silently evaluates to a discarded value. Most often
        // it means the author wrote something like `send_signal "alert" 42`
        // and the trailing arg quietly became a stray expression statement.
        if (stmt.expression.kind !== "CallExpr") {
          this.#addError(
            "Statement has no effect — its value is computed and discarded. " +
            "Did you mean to assign with 'let' or 'set', or pass it as an argument to an action?",
            stmt.span.line, stmt.span.column,
          );
        }
        break;
    }
  }

  #validateExpression(expr) {
    switch (expr.kind) {
      case "Identifier":
        if (!this.#isResolvable(expr.name)) {
          // Offer a "did you mean?" across all names visible in scope so
          // typos in sensor names, constants, or state vars get caught
          // with a useful hint instead of a bare "Unknown identifier".
          const candidates = new Set([
            ...this.#constants, ...this.#stateVars,
            ...BUILTIN_SENSORS, ...this.#functions.keys(),
          ]);
          for (const scope of this.#localScopes) {
            for (const n of scope) candidates.add(n);
          }
          const suggestion = findClosestMatch(expr.name, candidates);
          const hint = suggestion ? `. Did you mean '${suggestion}'?` : "";
          this.#addError(`Unknown identifier '${expr.name}'${hint}`, expr.span.line, expr.span.column);
        } else if (BUILTIN_SENSORS.has(expr.name)
                   && !this.#constants.has(expr.name)
                   && !this.#stateVars.has(expr.name)
                   && !this.#localScopes.some(s => s.has(expr.name))) {
          // Bare sensor name (no parens) — the compiler can't generate code
          // for this and would die later with "Unresolved identifier". Catch
          // it here with a clear message.
          this.#addError(
            `Sensor '${expr.name}' must be called with parentheses: '${expr.name}()'`,
            expr.span.line, expr.span.column,
          );
        } else if (this.#functions.has(expr.name)
                   && !this.#constants.has(expr.name)
                   && !this.#stateVars.has(expr.name)
                   && !this.#localScopes.some(s => s.has(expr.name))) {
          this.#addError(
            `Function '${expr.name}' must be called with parentheses: '${expr.name}(...)'`,
            expr.span.line, expr.span.column,
          );
        } else {
          if (this.#stateMeta.has(expr.name)) this.#stateMeta.get(expr.name).used = true;
          if (this.#constMeta.has(expr.name)) this.#constMeta.get(expr.name).used = true;
        }
        break;

      case "CallExpr":
        // Method-call syntax `obj.method()` arrives with a MemberExpr callee.
        // Reject it explicitly — without this, the call into findClosestMatch
        // below tries .toLowerCase() on an object and crashes the compiler.
        if (typeof expr.callee !== "string") {
          this.#addError(
            "Method-call syntax 'obj.method(...)' is not supported. " +
            "Use a top-level function or sensor instead.",
            expr.span.line, expr.span.column,
          );
          break;
        }
        if (!BUILTIN_SENSORS.has(expr.callee) && !this.#functions.has(expr.callee)) {
          // Suggest from BOTH builtins and user-declared functions so a typo
          // of a user fn finds the right candidate instead of a similarly
          // spelled builtin.
          const candidates = new Set(BUILTIN_SENSORS);
          for (const name of this.#functions.keys()) candidates.add(name);
          const suggestion = findClosestMatch(expr.callee, candidates);
          const hint = suggestion ? `. Did you mean '${suggestion}'?` : "";
          this.#addError(`Unknown function '${expr.callee}'${hint}`, expr.span.line, expr.span.column);
        } else if (this.#functions.has(expr.callee)) {
          const fn = this.#functions.get(expr.callee);
          if (fn.params.length !== expr.args.length) {
            this.#addError(
              `Function '${expr.callee}' expects ${fn.params.length} argument(s), got ${expr.args.length}`,
              expr.span.line, expr.span.column,
            );
          }
        }
        for (const arg of expr.args) {
          this.#validateExpression(arg);
        }
        break;

      case "BinaryExpr":
        this.#validateExpression(expr.left);
        this.#validateExpression(expr.right);
        break;

      case "UnaryExpr":
        this.#validateExpression(expr.operand);
        break;

      case "ComparisonExpr":
        this.#validateExpression(expr.left);
        this.#validateExpression(expr.right);
        break;

      case "MemberExpr":
        this.#validateExpression(expr.object);
        break;

      case "IndexExpr":
        this.#validateExpression(expr.object);
        this.#validateExpression(expr.index);
        break;

      case "NumberLiteral":
      case "StringLiteral":
      case "BooleanLiteral":
      case "NullLiteral":
        break;
    }
  }

  #validateType(type) {
    const line = type.span ? type.span.line : 0;
    const col = type.span ? type.span.column : 0;
    if (!VALID_TYPES.has(type.name)) {
      const suggestion = findClosestMatch(type.name, VALID_TYPES);
      const hint = suggestion ? `. Did you mean '${suggestion}'?` : "";
      this.#addError(`Unknown type '${type.name}'${hint}`, line, col);
    }
    if (type.generic && !VALID_TYPES.has(type.generic)) {
      const suggestion = findClosestMatch(type.generic, VALID_TYPES);
      const hint = suggestion ? `. Did you mean '${suggestion}'?` : "";
      this.#addError(`Unknown generic type '${type.generic}'${hint}`, line, col);
    }
  }

  #isResolvable(name) {
    if (this.#constants.has(name) || this.#stateVars.has(name)) return true;
    for (let i = this.#localScopes.length - 1; i >= 0; i--) {
      if (this.#localScopes[i].has(name)) return true;
    }
    // Built-in sensors without () are also valid identifiers in some contexts
    if (BUILTIN_SENSORS.has(name)) return true;
    // User-defined function names are valid references
    if (this.#functions.has(name)) return true;
    return false;
  }

  #pushScope() {
    this.#localScopes.push(new Set());
  }

  #popScope() {
    this.#localScopes.pop();
  }

  #addLocal(name, span = null) {
    if (this.#localScopes.length > 0) {
      const scope = this.#localScopes[this.#localScopes.length - 1];
      if (scope.has(name) && span) {
        this.#addWarning(`Local '${name}' shadows an existing local in the same scope`, span.line, span.column);
      }
      scope.add(name);
    }
  }

  #addError(message, line, column) {
    this.#diagnostics.push({ severity: "error", message, line, column });
  }

  #addWarning(message, line, column) {
    this.#diagnostics.push({ severity: "warning", message, line, column });
  }
}
