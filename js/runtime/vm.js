// ============================================================================
// ArenaScript VM — Stack-based bytecode interpreter
// ============================================================================

import { Op } from "./opcodes.js";
import { ExecutionBudget, BudgetExceededError } from "./budget.js";
import { BUDGET_INSTRUCTIONS } from "../shared/config.js";

export class VM {
  static MAX_STACK_DEPTH = 1024;
  static MAX_CALL_DEPTH = 64;

  constructor(program, robotId, sensorGateway) {
    this.program = program;
    this.bytecode = program.bytecode;
    this.constants = []; // Set via setConstants() after construction
    this.robotId = robotId;
    this.sensorGateway = sensorGateway;
    this.budget = new ExecutionBudget();

    this.ip = 0;
    this.stack = [];
    this.callStack = [];
    this.actions = [];
    this.iterStack = [];
    this.timers = []; // { triggerTick, bodyOffset, repeat, interval }
    this.currentTick = 0;

    // Initialize state slots with default values
    this.stateSlots = program.stateSlots.map(s => s.initialValue);
    // Size locals array to fit max call depth * local window size
    const localsSize = Math.max(256, (program.localWindowSize || 1) * VM.MAX_CALL_DEPTH);
    this.locals = new Array(localsSize).fill(null);
    this.localBase = 0;
    // Source map from the compiler: bytecode offset -> { line, column }
    // Used to tag runtime errors with their origin line for better DX.
    this.sourceMap = program.sourceMap ?? new Map();
    this.lastSourceLocation = null;
  }

  /** Look up the nearest compiled source location at or before the given offset. */
  nearestSourceLocation(offset) {
    if (!this.sourceMap || this.sourceMap.size === 0) return null;
    // Walk backwards until we find a mapped offset — compiler only records
    // source info on instructions that originate from the AST.
    for (let i = offset; i >= 0; i--) {
      const loc = this.sourceMap.get(i);
      if (loc) return loc;
    }
    return null;
  }

  /** Execute an event handler */
  executeEvent(eventType, event, currentTick) {
    if (currentTick !== undefined) this.currentTick = currentTick;

    const offset = this.program.eventHandlers.get(eventType);
    if (offset === undefined) {
      return { actions: [], budgetExceeded: false };
    }

    this.ip = offset;
    this.stack = [];
    this.actions = [];
    this.budget.reset();
    this.callStack = [];
    this.iterStack = [];
    this.localBase = 0;

    // Push event data onto the stack for handlers that declare a parameter.
    // The compiled handler will pop it into a local slot via STORE_LOCAL.
    // We rely on an explicit set populated by the compiler rather than
    // inspecting bytecode, which is brittle and can misfire if the first
    // statement in a paramless handler happens to compile to STORE_LOCAL.
    if (event && this.program.eventHandlerHasParam && this.program.eventHandlerHasParam.has(eventType)) {
      this.stack.push(this.eventToVMObject(event));
    }

    return this.run();
  }

  run() {
    let budgetExceeded = false;
    let error;
    const _budgetStart = this.budget.instructions;

    try {
      while (this.ip < this.bytecode.length) {
        this.budget.tick();
        // Track the most recent annotated source location so that any
        // runtime error thrown by this opcode (stack underflow, bad call,
        // etc.) can be reported with a line/column instead of just an
        // opaque message.
        const preIp = this.ip;
        const loc = this.sourceMap.get(preIp);
        if (loc) this.lastSourceLocation = loc;
        const op = this.bytecode[this.ip++];

        switch (op) {
          case Op.CONST_NUM: {
            const idx = this.readU16();
            const c = this.constants[idx];
            this.push(c && c.type === "number" ? c.value : 0);
            break;
          }

          case Op.CONST_STR: {
            const idx = this.readU16();
            const c = this.constants[idx];
            this.push(c && c.type === "string" ? c.value : "");
            break;
          }

          case Op.CONST_BOOL: {
            const val = this.readU16();
            this.push(val !== 0);
            break;
          }

          case Op.CONST_NULL:
            this.push(null);
            break;

          case Op.LOAD_LOCAL: {
            const slot = this.localBase + this.readU16();
            if (slot >= this.locals.length) {
              throw new Error(`Local slot ${slot} out of bounds (max ${this.locals.length - 1})`);
            }
            this.budget.memoryOp();
            this.push(this.locals[slot]);
            break;
          }

          case Op.STORE_LOCAL: {
            const slot = this.localBase + this.readU16();
            if (slot >= this.locals.length) {
              throw new Error(`Local slot ${slot} out of bounds (max ${this.locals.length - 1})`);
            }
            this.budget.memoryOp();
            this.locals[slot] = this.pop();
            break;
          }

          case Op.LOAD_STATE: {
            const idx = this.readU16();
            if (idx >= this.stateSlots.length) {
              throw new Error(`State slot ${idx} out of bounds (max ${this.stateSlots.length - 1})`);
            }
            this.budget.memoryOp();
            this.push(this.stateSlots[idx]);
            break;
          }

          case Op.STORE_STATE: {
            const idx = this.readU16();
            if (idx >= this.stateSlots.length) {
              throw new Error(`State slot ${idx} out of bounds (max ${this.stateSlots.length - 1})`);
            }
            this.budget.memoryOp();
            this.stateSlots[idx] = this.pop();
            break;
          }

          case Op.LOAD_CONST: {
            const idx = this.readU16();
            const c = this.constants[idx];
            if (!c) { this.push(null); break; }
            if (c.type === "null") this.push(null);
            else this.push(c.value);
            break;
          }

          // Arithmetic — ADD also doubles as string concatenation when
          // either operand is a string. All other operators stay numeric.
          case Op.ADD: {
            const rawB = this.pop();
            const rawA = this.pop();
            if (typeof rawA === "string" || typeof rawB === "string") {
              this.push(this.stringify(rawA) + this.stringify(rawB));
            } else {
              const bn = (typeof rawB === "number" && Number.isFinite(rawB)) ? rawB : 0;
              const an = (typeof rawA === "number" && Number.isFinite(rawA)) ? rawA : 0;
              this.push(an + bn);
            }
            break;
          }
          case Op.SUB: { const b = this.popNum(); const a = this.popNum(); this.push(a - b); break; }
          case Op.MUL: { const b = this.popNum(); const a = this.popNum(); this.push(a * b); break; }
          case Op.DIV: { const b = this.popNum(); const a = this.popNum(); this.push(b !== 0 ? a / b : 0); break; }
          case Op.MOD: { const b = this.popNum(); const a = this.popNum(); this.push(b !== 0 ? a % b : 0); break; }
          case Op.NEG: { this.push(-this.popNum()); break; }

          // Comparison
          case Op.EQ:  { const b = this.pop(); const a = this.pop(); this.push(a === b); break; }
          case Op.NEQ: { const b = this.pop(); const a = this.pop(); this.push(a !== b); break; }
          case Op.LT:  { const b = this.popNum(); const a = this.popNum(); this.push(a < b); break; }
          case Op.LTE: { const b = this.popNum(); const a = this.popNum(); this.push(a <= b); break; }
          case Op.GT:  { const b = this.popNum(); const a = this.popNum(); this.push(a > b); break; }
          case Op.GTE: { const b = this.popNum(); const a = this.popNum(); this.push(a >= b); break; }

          // Logic (AND/OR opcodes are reserved but unused — compiler emits short-circuit jumps instead)
          case Op.AND: { const b = this.popBool(); const a = this.popBool(); this.push(a && b); break; }
          case Op.OR:  { const b = this.popBool(); const a = this.popBool(); this.push(a || b); break; }
          case Op.NOT: { this.push(!this.popBool()); break; }

          // Jumps
          case Op.JMP: {
            this.ip = this.readU16();
            break;
          }
          case Op.JMP_IF_FALSE: {
            const target = this.readU16();
            if (!this.isTruthy(this.pop())) this.ip = target;
            break;
          }
          case Op.JMP_IF_TRUE: {
            const target = this.readU16();
            if (this.isTruthy(this.pop())) this.ip = target;
            break;
          }

          // Functions
          case Op.CALL: {
            this.budget.callFunction();
            if (this.callStack.length >= VM.MAX_CALL_DEPTH) {
              throw new Error("Call stack overflow: maximum recursion depth exceeded");
            }
            const target = this.readU16();
            const prevBase = this.localBase;
            // Each call frame gets its own local variable window
            this.callStack.push({ returnAddress: this.ip, localBase: prevBase });
            this.localBase = prevBase + this.program.localWindowSize;
            this.ip = target;
            break;
          }

          case Op.CALL_BUILTIN: {
            this.budget.callSensor();
            const nameIdx = this.readU16();
            const argCount = this.bytecode[this.ip++];
            const nameConst = this.constants[nameIdx];
            const name = nameConst && nameConst.type === "string" ? nameConst.value : "";
            const args = [];
            for (let i = 0; i < argCount; i++) {
              args.unshift(this.pop());
            }
            const result = this.sensorGateway(this.robotId, name, args);
            this.push(result);
            break;
          }

          case Op.RETURN: {
            if (this.callStack.length > 0) {
              const frame = this.callStack.pop();
              this.ip = frame.returnAddress;
              this.localBase = frame.localBase;
            } else {
              return { actions: this.actions, budgetExceeded: false, instructionsUsed: _budgetStart - this.budget.instructions };
            }
            break;
          }

          case Op.RETURN_VAL: {
            const val = this.pop();
            if (this.callStack.length > 0) {
              const frame = this.callStack.pop();
              this.ip = frame.returnAddress;
              this.localBase = frame.localBase;
              this.push(val);
            } else {
              // At top-level (event handler) — return with value
              this.push(val);
              return { actions: this.actions, budgetExceeded: false, instructionsUsed: _budgetStart - this.budget.instructions };
            }
            break;
          }

          // Actions
          case Op.ACTION: {
            const argCount = this.readU16();
            const args = [];
            for (let i = 0; i < argCount; i++) {
              args.unshift(this.pop());
            }
            const actionName = this.pop();
            this.actions.push(this.buildActionIntent(actionName, args));
            break;
          }

          // Member access
          case Op.GET_MEMBER: {
            const propIdx = this.readU16();
            const propConst = this.constants[propIdx];
            const prop = propConst && propConst.type === "string" ? propConst.value : "";
            const obj = this.pop();
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
              // Sandbox: block access to prototype-inherited properties
              if (!Object.prototype.hasOwnProperty.call(obj, prop)) {
                this.push(null);
              } else {
                this.push(obj[prop] ?? null);
              }
            } else if (Array.isArray(obj) && prop === "length") {
              // Ergonomic: allow `myList.length` as a shortcut for length()
              this.push(obj.length);
            } else {
              this.push(null);
            }
            break;
          }

          case Op.GET_INDEX: {
            const idx = this.pop();
            const list = this.pop();
            if (!Array.isArray(list)) { this.push(null); break; }
            const i = Math.trunc(typeof idx === "number" && Number.isFinite(idx) ? idx : 0);
            // Support negative indices (from end), return null on out-of-bounds
            // so bots get predictable behaviour rather than undefined crashes.
            const real = i < 0 ? list.length + i : i;
            if (real < 0 || real >= list.length) { this.push(null); break; }
            this.push(list[real] ?? null);
            break;
          }

          case Op.LIST_LEN: {
            const list = this.pop();
            this.push(Array.isArray(list) ? list.length : 0);
            break;
          }

          // Iteration
          case Op.ITER_START: {
            if (this.iterStack.length >= VM.MAX_CALL_DEPTH) {
              throw new Error("Iterator stack overflow: too many nested loops");
            }
            const list = this.pop();
            if (Array.isArray(list)) {
              this.iterStack.push({ items: list, index: 0 });
            } else {
              this.iterStack.push({ items: [], index: 0 });
            }
            break;
          }

          case Op.ITER_NEXT: {
            const target = this.readU16();
            const iter = this.iterStack[this.iterStack.length - 1];
            if (!iter || iter.index >= iter.items.length) {
              this.ip = target;
            } else {
              this.push(iter.items[iter.index]);
              iter.index++;
            }
            break;
          }

          case Op.ITER_END: {
            this.iterStack.pop();
            break;
          }

          // Timers
          case Op.SCHEDULE_ONCE: {
            const bodyEnd = this.readU16();
            const delay = Math.max(1, this.popNum());
            const bodyStart = this.ip; // body begins right after the opcode+operand
            // Dedupe: don't register the same (one-shot) body twice. Without
            // this, an `after N { ... }` inside `on tick` would queue a new
            // timer every tick.
            if (!this.timers.some(t => t.bodyOffset === bodyStart && !t.repeat)) {
              this.timers.push({
                triggerTick: this.currentTick + delay,
                bodyOffset: bodyStart,
                repeat: false,
                interval: 0,
              });
            }
            this.ip = bodyEnd; // skip past the body
            break;
          }

          case Op.SCHEDULE_REPEAT: {
            const bodyEnd = this.readU16();
            const interval = Math.max(1, this.popNum());
            const bodyStart = this.ip;
            // Dedupe by body offset — `every N { ... }` inside `on tick` would
            // otherwise register a new repeating timer every single tick and
            // grow unbounded.
            if (this.timers.some(t => t.bodyOffset === bodyStart && t.repeat)) {
              this.ip = bodyEnd;
              break;
            }
            this.timers.push({
              triggerTick: this.currentTick + interval,
              bodyOffset: bodyStart,
              repeat: true,
              interval,
            });
            this.ip = bodyEnd;
            break;
          }

          // Stack
          case Op.POP: this.pop(); break;
          case Op.DUP: { const v = this.peek(); this.push(v); break; }

          case Op.HALT:
            return { actions: this.actions, budgetExceeded: false, instructionsUsed: _budgetStart - this.budget.instructions };

          default: {
            const loc = this.lastSourceLocation ?? this.nearestSourceLocation(this.ip - 1);
            const hint = loc ? ` (near line ${loc.line}, col ${loc.column})` : "";
            return {
              actions: this.actions,
              budgetExceeded: false,
              instructionsUsed: _budgetStart - this.budget.instructions,
              error: `Unknown opcode: 0x${op.toString(16)}${hint}`,
            };
          }
        }
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        budgetExceeded = true;
      } else {
        const base = e instanceof Error ? e.message : String(e);
        // Walk the source map backwards from the current IP to find the
        // closest annotated instruction — lets us report "stack underflow
        // at 14:7" instead of bare "Stack underflow".
        const loc = this.lastSourceLocation ?? this.nearestSourceLocation(this.ip - 1);
        error = loc ? `${base} (at line ${loc.line}, col ${loc.column})` : base;
      }
    }

    return { actions: this.actions, budgetExceeded, instructionsUsed: _budgetStart - this.budget.instructions, error };
  }

  // --- Stack helpers ---

  push(val) {
    if (this.stack.length >= VM.MAX_STACK_DEPTH) {
      throw new Error("Stack overflow: maximum depth exceeded");
    }
    this.stack.push(val);
  }

  pop() {
    if (this.stack.length === 0) {
      throw new Error("Stack underflow: attempted to pop from empty stack");
    }
    return this.stack.pop();
  }

  peek() {
    if (this.stack.length === 0) {
      throw new Error("Stack underflow: attempted to peek at empty stack");
    }
    return this.stack[this.stack.length - 1];
  }

  popNum() {
    const v = this.pop();
    // Coerce non-numeric or NaN values to 0 so arithmetic can't poison the
    // stack with NaN, which would then propagate into world state and
    // ultimately break determinism / invariants.
    if (typeof v !== "number" || !Number.isFinite(v)) return 0;
    return v;
  }

  popBool() {
    return this.isTruthy(this.pop());
  }

  isTruthy(v) {
    if (v === null || v === false || v === 0) return false;
    return true;
  }

  /** Convert any VM value to a readable string (used by ADD and log()). */
  stringify(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "0";
      return Number.isInteger(v) ? v.toString() : v.toFixed(2);
    }
    if (typeof v === "boolean") return v ? "true" : "false";
    if (Array.isArray(v)) return `[list x${v.length}]`;
    if (v && typeof v === "object") {
      if ("x" in v && "y" in v) return `(${this.stringify(v.x)}, ${this.stringify(v.y)})`;
      if (v.id) return `<${v.id}>`;
      return "<object>";
    }
    return String(v);
  }

  readU16() {
    const hi = this.bytecode[this.ip++] ?? 0;
    const lo = this.bytecode[this.ip++] ?? 0;
    return (hi << 8) | lo;
  }

  // --- Helpers ---

  buildActionIntent(actionName, args) {
    const intent = {
      robotId: this.robotId,
      type: actionName,
    };

    if (args.length > 0) {
      const arg = args[0];
      if (typeof arg === "string") {
        // String args: signal data, waypoint names, entity IDs
        if (actionName === "send_signal" || actionName === "mark_position") {
          intent.data = arg;
        } else {
          intent.target = arg;
        }
      } else if (typeof arg === "number") {
        // Numeric args (e.g. send_signal with numeric data)
        if (actionName === "send_signal") {
          intent.data = arg;
        } else {
          intent.target = arg;
        }
      } else if (arg && typeof arg === "object" && "x" in arg && "y" in arg) {
        intent.target = {
          x: Number(arg.x),
          y: Number(arg.y),
        };
      } else if (arg && typeof arg === "object" && "id" in arg) {
        intent.target = arg.id;
      } else if (arg !== null && arg !== undefined) {
        // For send_signal with any other value type
        if (actionName === "send_signal") {
          intent.data = arg;
        }
      }
    }

    return intent;
  }

  eventToVMObject(event) {
    const obj = Object.create(null);
    obj.type = event.type;
    obj.tick = event.tick;
    if (event.data) {
      for (const [k, v] of Object.entries(event.data)) {
        // Only allow primitives and plain objects into the VM
        if (typeof v === "function" || typeof v === "symbol") continue;
        if (typeof v === "object" && v !== null) {
          // Shallow-clone plain objects to prevent reference leaks
          const safe = Object.create(null);
          for (const [pk, pv] of Object.entries(v)) {
            if (typeof pv !== "function" && typeof pv !== "symbol") {
              safe[pk] = pv;
            }
          }
          obj[k] = safe;
        } else {
          obj[k] = v;
        }
      }
    }
    return obj;
  }

  /** Execute any timers that have fired at the given tick */
  executeTimers(tick) {
    this.currentTick = tick;
    const allActions = [];
    const firedIndices = [];

    for (let i = 0; i < this.timers.length; i++) {
      const timer = this.timers[i];
      if (tick >= timer.triggerTick) {
        // Execute the timer body
        this.ip = timer.bodyOffset;
        this.stack = [];
        this.actions = [];
        this.budget.reset();
        this.callStack = [];
        this.iterStack = [];
        this.localBase = 0;

        const result = this.run();
        allActions.push(...result.actions);

        if (timer.repeat) {
          timer.triggerTick = tick + timer.interval;
        } else {
          firedIndices.push(i);
        }
      }
    }

    // Remove one-shot timers that fired (reverse order to preserve indices)
    for (let i = firedIndices.length - 1; i >= 0; i--) {
      this.timers.splice(firedIndices[i], 1);
    }

    return allActions;
  }

  /** Set the constant pool directly (used by the match runner) */
  setConstants(constants) {
    this.constants = constants;
  }

  /** Get current state for replay/inspection */
  getState() {
    return [...this.stateSlots];
  }
}
